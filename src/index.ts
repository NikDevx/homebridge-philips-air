import {
  API,
  APIEvent,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  DynamicPlatformPlugin,
  HAP,
  Logging,
  PlatformAccessory,
  PlatformAccessoryEvent,
  PlatformConfig
} from 'homebridge';
import {AirClient, HttpClient, CoapClient, PlainCoapClient, HttpClientLegacy} from 'philips-air';
import {promisify} from 'util';
import * as fs from 'fs';
import {PhilipsAirPlatformConfig, DeviceConfig} from './configTypes';
import {PurifierStatus, PurifierFilters, PurifierFirmware} from './deviceTypes';

let hap: HAP;
let Accessory: typeof PlatformAccessory;

const PLUGIN_NAME = 'homebridge-philips-air';
const PLATFORM_NAME = 'philipsAir';

enum CommandType {
  Polling = 0,
  GetFirmware,
  GetFilters,
  GetStatus,
  GetWaterLevel,
  GetTemperature,
  GetHumidity,
  SetData
}

type Command = {
  purifier: Purifier,
  type: CommandType,
  callback?: (error?: Error | null | undefined) => void,
  data?: any // eslint-disable-line @typescript-eslint/no-explicit-any
};

type Purifier = {
  accessory: PlatformAccessory,
  client: AirClient,
  config: DeviceConfig,
  timeout?: NodeJS.Timeout,
  lastfirmware?: number,
  lastfilters?: number,
  laststatus?: number,
  aqil?: number,
  uil?: string
};

class PhilipsAirPlatform implements DynamicPlatformPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private readonly config: PhilipsAirPlatformConfig;
  private readonly timeout: number;
  private readonly cachedAccessories: Array<PlatformAccessory> = [];
  private readonly purifiers: Map<string, Purifier> = new Map();
  private readonly commandQueue: Array<Command> = [];
  private queueRunning = false;

  enqueuePromise = promisify(this.enqueueCommand);

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.config = config as unknown as PhilipsAirPlatformConfig;
    this.api = api;

    this.timeout = (this.config.timeout_seconds || 5) * 1000;

    api.on(APIEvent.DID_FINISH_LAUNCHING, this.didFinishLaunching.bind(this));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  didFinishLaunching(): void {
    const ips: Array<string> = [];
    this.config.devices.forEach((device: DeviceConfig) => {
      this.addAccessory(device);
      const uuid = hap.uuid.generate(device.ip);
      ips.push(uuid);
    });

    const badAccessories: Array<PlatformAccessory> = [];
    this.cachedAccessories.forEach(cachedAcc => {
      if (!ips.includes(cachedAcc.UUID)) {
        badAccessories.push(cachedAcc);
      }
    });
    this.removeAccessories(badAccessories);

    this.purifiers.forEach((purifier) => {
      this.enqueueCommand(CommandType.Polling, purifier);
      this.enqueueCommand(CommandType.GetFirmware, purifier);
      this.enqueueCommand(CommandType.GetStatus, purifier);
      this.enqueueCommand(CommandType.GetFilters, purifier);
      this.enqueueCommand(CommandType.GetWaterLevel, purifier);
      this.enqueueCommand(CommandType.GetTemperature, purifier);
      this.enqueueCommand(CommandType.GetHumidity, purifier);
    });
  }

  async storeKey(purifier: Purifier): Promise<void> {
    if (purifier.client && purifier.client instanceof HttpClient) {
      purifier.accessory.context.key = (purifier.client as HttpClient).key;
    }
  }

  async setData(purifier: Purifier, values: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    callback?: (error?: Error | null | undefined) => void): Promise<void> {
    try {
      await purifier.client?.setValues(values);
      await this.storeKey(purifier);
      if (callback) {
        callback();
      }
    } catch (err) {
      if (callback) {
        callback(err);
      }
    }
  }

  async updatePolling(purifier: Purifier): Promise<void> {
    try {
      const status: PurifierStatus = await purifier.client?.getStatus();
      purifier.laststatus = Date.now();
      await this.storeKey(purifier);
      // Polling interval
      const polling = purifier.config.polling || 60;
      setInterval(function() {
        const qualityService = purifier.accessory.getService(hap.Service.AirQualitySensor);
        if (qualityService) {
          const iaql = Math.ceil(status.iaql / 3);
          qualityService
            .updateCharacteristic(hap.Characteristic.AirQuality, iaql)
            .updateCharacteristic(hap.Characteristic.PM2_5Density, status.pm25);
        }
        if (purifier.config.water_level) {
          const WaterLevel = purifier.accessory.getService('Water level');
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          WaterLevel.updateCharacteristic(hap.Characteristic.WaterLevel, status.wl);
        }
        if (purifier.config.humidity_sensor) {
          const humidity_sensor = purifier.accessory.getService('Humidity');
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          humidity_sensor.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, status.rh);
        }
        if (purifier.config.temperature_sensor) {
          const temperature_sensor = purifier.accessory.getService('Temperature');
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          temperature_sensor.updateCharacteristic(hap.Characteristic.CurrentTemperature, status.temp);
        }
        if (purifier.config.humidifier) {
          const Humidifier = purifier.accessory.getService('Humidifier');
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          Humidifier.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, status.rh);
        }
        if (purifier.config.logger) {
          const logger_temp = fs.createWriteStream('/usr/lib/node_modules/homebridge-philips-air/sensor/temp.txt', {
            flags: 'w'
          });
          logger_temp.write(status.temp.toString());
          logger_temp.end();
          const logger_hum = fs.createWriteStream('/usr/lib/node_modules/homebridge-philips-air/sensor/hum.txt', {
            flags: 'w'
          });
          logger_hum.write(status.rh.toString());
          logger_hum.end();
        }
      }, polling * 1000);
    } catch (err) {
      this.log.error('[' + purifier.config.name + '] Unable to load humidity_sensor info: ' + err);
    }
  }

  async updateFirmware(purifier: Purifier): Promise<void> {
    if (!purifier.lastfirmware || Date.now() - purifier.lastfirmware > 30 * 1000) {
      try {
        purifier.lastfirmware = Date.now();
        const firmware: PurifierFirmware = await purifier.client?.getFirmware();
        await this.storeKey(purifier);

        const accInfo = purifier.accessory.getService(hap.Service.AccessoryInformation);
        if (accInfo) {
          const name = firmware.name.replace('_', '/');

          accInfo
            .updateCharacteristic(hap.Characteristic.Manufacturer, 'Philips')
            .updateCharacteristic(hap.Characteristic.SerialNumber, purifier.config.ip)
            .updateCharacteristic(hap.Characteristic.Model, name)
            .updateCharacteristic(hap.Characteristic.FirmwareRevision, firmware.version);
        }
      } catch (err) {
        this.log.error('[' + purifier.config.name + '] Unable to load firmware info: ' + err);
      }
    }
  }

  async updateFilters(purifier: Purifier): Promise<void> {
    if (!purifier.lastfilters || Date.now() - purifier.lastfilters > 30 * 1000) {
      try {
        const filters: PurifierFilters = await purifier.client?.getFilters();
        purifier.lastfilters = Date.now();
        await this.storeKey(purifier);

        const preFilter = purifier.accessory.getService('Pre-filter');
        if (preFilter) {
          const fltsts0change = filters.fltsts0 == 0;
          const fltsts0life = filters.fltsts0 / 360 * 100;

          preFilter
            .updateCharacteristic(hap.Characteristic.FilterChangeIndication, fltsts0change)
            .updateCharacteristic(hap.Characteristic.FilterLifeLevel, fltsts0life);
        }

        const carbonFilter = purifier.accessory.getService('Active carbon filter');
        if (carbonFilter) {
          const fltsts2change = filters.fltsts2 == 0;
          const fltsts2life = filters.fltsts2 / 2400 * 100;

          carbonFilter
            .updateCharacteristic(hap.Characteristic.FilterChangeIndication, fltsts2change)
            .updateCharacteristic(hap.Characteristic.FilterLifeLevel, fltsts2life);
        }

        const hepaFilter = purifier.accessory.getService('HEPA filter');
        if (hepaFilter) {
          const fltsts1change = filters.fltsts1 == 0;
          const fltsts1life = filters.fltsts1 / 4800 * 100;

          hepaFilter
            .updateCharacteristic(hap.Characteristic.FilterChangeIndication, fltsts1change)
            .updateCharacteristic(hap.Characteristic.FilterLifeLevel, fltsts1life);
        }
      } catch (err) {
        this.log.error('[' + purifier.config.name + '] Unable to load filter info: ' + err);
      }
    }
  }

  async updateWaterLevel(purifier: Purifier): Promise<void> {
    try {
      const status: PurifierStatus = await purifier.client?.getStatus();
      purifier.laststatus = Date.now();
      await this.storeKey(purifier);
      if (purifier.config.water_level) {
        const WatereLevel = purifier.accessory.getService('Water level');
        if (status.wl == 0) {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          WatereLevel.updateCharacteristic(hap.Characteristic.LeakDetected, 1);
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          WatereLevel.updateCharacteristic(hap.Characteristic.WaterLevel, 0);
        } else {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          WatereLevel.updateCharacteristic(hap.Characteristic.LeakDetected, 0);
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          WatereLevel.updateCharacteristic(hap.Characteristic.WaterLevel, status.wl);
        }
      }

    } catch (err) {
      this.log.error('[' + purifier.config.name + '] Unable to load water level info: ' + err);
    }
  }

  async updateTemperature(purifier: Purifier): Promise<void> {
    try {
      const status: PurifierStatus = await purifier.client?.getStatus();
      purifier.laststatus = Date.now();
      await this.storeKey(purifier);
      if (purifier.config.temperature_sensor) {
        const temperature_sensor = purifier.accessory.getService('Temperature');
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        temperature_sensor.updateCharacteristic(hap.Characteristic.CurrentTemperature, status.temp);
      }
    } catch (err) {
      this.log.error('[' + purifier.config.name + '] Unable to load temperature_sensor info: ' + err);
    }
  }

  async updateHumidity(purifier: Purifier): Promise<void> {
    try {
      const status: PurifierStatus = await purifier.client?.getStatus();
      purifier.laststatus = Date.now();
      await this.storeKey(purifier);
      if (purifier.config.humidity_sensor) {
        const humidity_sensor = purifier.accessory.getService('Humidity');
        const Humidifier = purifier.accessory.getService('Humidifier');
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        humidity_sensor.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, status.rh);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        Humidifier.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, status.rh);
      }
    } catch (err) {
      this.log.error('[' + purifier.config.name + '] Unable to load humidity_sensor info: ' + err);
    }
  }

  async updateStatus(purifier: Purifier): Promise<void> {
    try {
      const status: PurifierStatus = await purifier.client?.getStatus();
      purifier.laststatus = Date.now();
      await this.storeKey(purifier);

      const purifierService = purifier.accessory.getService(hap.Service.AirPurifier);
      if (purifierService) {
        const mode = !(status.mode == 'M');
        const state = parseInt(status.pwr) * 2;

        let speed = 0;
        if (status.pwr == '1') {
          if (!mode) {
            if (status.om == 't') {
              speed = 100;
            } else if (status.om == 's') {
              speed = 20;
            } else {
              let divisor = 25;
              let offset = 0;
              if (purifier.config.sleep_speed) {
                divisor = 20;
                offset = 1;
              }
              speed = (parseInt(status.om) + offset) * divisor;
            }
          }
        }
        purifierService
          .updateCharacteristic(hap.Characteristic.Active, status.pwr)
          .updateCharacteristic(hap.Characteristic.TargetAirPurifierState, mode)
          .updateCharacteristic(hap.Characteristic.CurrentAirPurifierState, state)
          .updateCharacteristic(hap.Characteristic.LockPhysicalControls, status.cl)
          .updateCharacteristic(hap.Characteristic.RotationSpeed, speed);
      }

      const qualityService = purifier.accessory.getService(hap.Service.AirQualitySensor);
      if (qualityService) {
        const iaql = Math.ceil(status.iaql / 3);

        qualityService
          .updateCharacteristic(hap.Characteristic.AirQuality, iaql)
          .updateCharacteristic(hap.Characteristic.PM2_5Density, status.pm25);
      }

      if (purifier.config.light_control) {
        purifier.uil = status.uil;
        purifier.aqil = status.aqil;

        const lightsService = purifier.accessory.getService('Lights');
        // const buttonsService = purifier.accessory.getService(purifier.config.name + ' Buttons');
        if (status.pwr == '1') {
          if (lightsService) {
            lightsService
              .updateCharacteristic(hap.Characteristic.On, purifier.aqil > 0)
              .updateCharacteristic(hap.Characteristic.Brightness, purifier.aqil);
          }
        } else if (lightsService) {
          lightsService.updateCharacteristic(hap.Characteristic.On, false);
        }
      }
      if (purifier.config.humidifier) {
        const Humidifier = purifier.accessory.getService('Humidifier');
        if (status.pwr == '1') {
          let speed_humidity = 0;
          if (status.func == 'PH') {
            if (status.rhset == 40) {
              speed_humidity = 25;
            } else if (status.rhset == 50) {
              speed_humidity = 50;
            } else if (status.rhset == 60) {
              speed_humidity = 75;
            } else if (status.rhset == 70) {
              speed_humidity = 100;
            }
          }
          if (Humidifier) {
            if (status.rhset > 1) {
              Humidifier
                .updateCharacteristic(hap.Characteristic.Active, status.pwr)
                .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, 2)
                .updateCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState, 1)
                .updateCharacteristic(hap.Characteristic.RelativeHumidityDehumidifierThreshold, speed_humidity)
                .updateCharacteristic(hap.Characteristic.RelativeHumidityDehumidifierThreshold, speed_humidity);
            }
            Humidifier
              .updateCharacteristic(hap.Characteristic.RotationSpeed, speed_humidity)
              .updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, status.rh)
              .updateCharacteristic(hap.Characteristic.TargetRelativeHumidity, status.rhset);

          }
        }
      }
    } catch (err) {
      this.log.error('[' + purifier.config.name + '] Unable to load status info: ' + err);
    }
  }

  async setPower(accessory: PlatformAccessory, state: CharacteristicValue): Promise<void> {
    const purifier = this.purifiers.get(accessory.displayName);

    if (purifier) {
      const values = {
        pwr: (state as boolean).toString(),
        mode: 'P'
      };
      if (purifier.config.allergic_func) {
        values.mode = 'A';
      }
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await this.enqueuePromise(CommandType.SetData, purifier, values);

        const purifierService = accessory.getService(hap.Service.AirPurifier);
        if (purifierService) {
          purifierService.updateCharacteristic(hap.Characteristic.CurrentAirPurifierState, state as number * 2);
          purifierService.updateCharacteristic(hap.Characteristic.TargetAirPurifierState, 0);
        }

        if (purifier.config.light_control) {
          const lightsService = accessory.getService('Lights');
          if (state) {
            if (lightsService && purifier.aqil) {
              lightsService
                .updateCharacteristic(hap.Characteristic.On, purifier.aqil > 0)
                .updateCharacteristic(hap.Characteristic.Brightness, purifier.aqil);
            }
            if (lightsService && purifier.uil) {
              lightsService.updateCharacteristic(hap.Characteristic.On, purifier.uil);
            }
          } else if (lightsService) {
            lightsService.updateCharacteristic(hap.Characteristic.On, false);
          }
        }
        if (purifier.config.humidifier) {
          const Humidifier = accessory.getService('Humidifier');
          let speed_humidity = 0;
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          if (Humidifier.func == 'PH') {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
            if (Humidifier.rhset == 40) {
              speed_humidity = 40;
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore
            } else if (Humidifier.rhset == 50) {
              speed_humidity = 50;
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore
            } else if (Humidifier.rhset == 60) {
              speed_humidity = 60;
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore
            } else if (Humidifier.rhset == 70) {
              speed_humidity = 70;
            }
          }
          if (state) {
            if (Humidifier) {
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore
              if (Humidifier.rhset > 1) {
                Humidifier
                  .updateCharacteristic(hap.Characteristic.Active, 1)
                  .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, 2)
                  .updateCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState, 1)
                  .updateCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold, speed_humidity)
                  .updateCharacteristic(hap.Characteristic.RelativeHumidityDehumidifierThreshold, speed_humidity);
              }
              Humidifier
                .updateCharacteristic(hap.Characteristic.RotationSpeed, speed_humidity)
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore
                .updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, Humidifier.rh)
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore
                .updateCharacteristic(hap.Characteristic.TargetRelativeHumidity, Humidifier.rhset);
            }
          } else if (Humidifier) {
            Humidifier
              .updateCharacteristic(hap.Characteristic.Active, 0)
              .updateCharacteristic(hap.Characteristic.RotationSpeed, 0)
              .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, 0)
              .updateCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold, 0)
              .updateCharacteristic(hap.Characteristic.RelativeHumidityDehumidifierThreshold, 0)
              .updateCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState, 0)
              .updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, 0)
              .updateCharacteristic(hap.Characteristic.TargetRelativeHumidity, 0);
          }
        }
      } catch (err) {
        this.log.error('[' + purifier.config.name + '] Error setting power: ' + err);
      }
    }
  }

  async setLights(accessory: PlatformAccessory, state: CharacteristicValue): Promise<void> {
    const purifier = this.purifiers.get(accessory.displayName);

    if (purifier) {
      const values = {
        uil: state ? purifier.aqil : 0
      };

      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await this.enqueuePromise(CommandType.SetData, purifier, values);
      } catch (err) {
        this.log.error('[' + purifier.config.name + '] Error setting lights: ' + err);
      }
    }
  }

  async setBrightness(accessory: PlatformAccessory, state: CharacteristicValue): Promise<void> {
    const purifier = this.purifiers.get(accessory.displayName);

    if (purifier) {
      const values = {
        aqil: state
      };

      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await this.enqueuePromise(CommandType.SetData, purifier, values);
      } catch (err) {
        this.log.error('[' + purifier.config.name + '] Error setting brightness: ' + err);
      }
    }
  }

  async setMode(accessory: PlatformAccessory, state: CharacteristicValue): Promise<void> {
    const purifier = this.purifiers.get(accessory.displayName);

    if (purifier) {
      const values = {
        mode: state ? 'P' : 'A'
      };
      if (purifier.config.allergic_func) {
        values.mode = state ? 'P' : 'A';
      } else {
        values.mode = state ? 'P' : 'M';
      }
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await this.enqueuePromise(CommandType.SetData, purifier, values);

        if (state != 0) {
          const purifierService = accessory.getService(hap.Service.AirPurifier);
          if (purifierService) {
            purifierService.updateCharacteristic(hap.Characteristic.RotationSpeed, 0);
          }
        }
      } catch (err) {
        this.log.error('[' + purifier.config.name + '] Error setting mode: ' + err);
      }
    }
  }

  async setLock(accessory: PlatformAccessory, state: CharacteristicValue): Promise<void> {
    const purifier = this.purifiers.get(accessory.displayName);

    if (purifier) {
      const values = {
        cl: state == 1
      };

      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await this.enqueuePromise(CommandType.SetData, purifier, values);
      } catch (err) {
        this.log.error('[' + purifier.config.name + '] Error setting lock: ' + err);
      }
    }
  }

  async setHumidity(accessory: PlatformAccessory, state: CharacteristicValue): Promise<void> {
    const purifier = this.purifiers.get(accessory.displayName);
    if (purifier) {
      const values = {
        func: state ? 'PH' : 'P'
      };
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await this.enqueuePromise(CommandType.SetData, purifier, values);
      } catch (err) {
        this.log.error('[' + purifier.config.name + '] Error setting func: ' + err);
      }
    }
  }

  async setHumidityTarget(accessory: PlatformAccessory, state: CharacteristicValue): Promise<void> {
    const purifier = this.purifiers.get(accessory.displayName);
    if (purifier) {
      const speed = state;
      if (speed > 0) {
        const values = {
          func: 'PH',
          rhset: 40
        };
        let speed_humidity = 0;
        if (speed == 40) {
          values.rhset = 40;
          speed_humidity = 40;
        } else if (speed == 50) {
          values.rhset = 50;
          speed_humidity = 50;
        } else if (speed == 60) {
          values.rhset = 60;
          speed_humidity = 60;
        } else if (speed == 70) {
          values.rhset = 70;
          speed_humidity = 70;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          await this.enqueuePromise(CommandType.SetData, purifier, values);
          const service = accessory.getService('Humidifier');
          if (service) {
            service
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
              .updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, service.rh)
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
              .updateCharacteristic(hap.Characteristic.TargetRelativeHumidity, service.rhset);
            if (values.rhset > 1) {
              service
                .updateCharacteristic(hap.Characteristic.Active, 1)
                .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, 2)
                .updateCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState, 1)
                .updateCharacteristic(hap.Characteristic.RelativeHumidityDehumidifierThreshold, speed_humidity)
                .updateCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold, speed_humidity);
            }
          }
          if (purifier.timeout) {
            clearTimeout(purifier.timeout);
          }
          purifier.timeout = setTimeout(() => {
            if (service) {
              service
                .updateCharacteristic(hap.Characteristic.RotationSpeed, speed_humidity);
            }
            purifier.timeout = undefined;
          }, 1000);
        } catch (err) {
          this.log.error('[' + purifier.config.name + '] Error setting humidifier: ' + err);
        }
      }
    }
  }

  async setFan(accessory: PlatformAccessory, state: CharacteristicValue): Promise<void> {
    const purifier = this.purifiers.get(accessory.displayName);

    if (purifier) {
      let divisor = 25;
      let offset = 0;
      if (purifier.config.sleep_speed) {
        divisor = 20;
        offset = 1;
      }
      const speed = Math.ceil(state as number / divisor);
      if (speed > 0) {
        const values = {
          mode: 'M',
          om: ''
        };
        if (offset == 1 && speed == 1) {
          values.om = 's';
        } else if (speed < 4 + offset) {
          values.om = (speed - offset).toString();
        } else {
          values.om = 't';
        }

        try {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          await this.enqueuePromise(CommandType.SetData, purifier, values);

          const service = accessory.getService(hap.Service.AirPurifier);
          if (service) {
            service.updateCharacteristic(hap.Characteristic.TargetAirPurifierState, 0);
          }

          if (purifier.timeout) {
            clearTimeout(purifier.timeout);
          }
          purifier.timeout = setTimeout(() => {
            if (service) {
              service.updateCharacteristic(hap.Characteristic.RotationSpeed, speed * divisor);
            }
            purifier.timeout = undefined;
          }, 1000);
        } catch (err) {
          this.log.error('[' + purifier.config.name + '] Error setting fan: ' + err);
        }
      }
    }
  }

  addAccessory(config: DeviceConfig): void {
    this.log('[' + config.name + '] Initializing accessory...');

    const uuid = hap.uuid.generate(config.ip);
    let accessory = this.cachedAccessories.find(cachedAcc => {
      return cachedAcc.UUID == uuid;
    });

    if (!accessory) {
      accessory = new Accessory(config.name, uuid);

      accessory.addService(hap.Service.AirPurifier, config.name);
      accessory.addService(hap.Service.AirQualitySensor, config.name);

      if (config.light_control) {
        accessory.addService(hap.Service.Lightbulb, 'Lights', 'Lights')
          .addCharacteristic(hap.Characteristic.Brightness);
      }

      accessory.addService(hap.Service.FilterMaintenance, 'Pre-filter', 'Pre-filter');
      accessory.addService(hap.Service.FilterMaintenance, 'Active carbon filter', 'Active carbon filter');
      accessory.addService(hap.Service.FilterMaintenance, 'HEPA filter', 'HEPA filter');
      if (config.water_level) {
        accessory.addService(hap.Service.LeakSensor, 'Water level', 'Water level');
      }
      if (config.temperature_sensor) {
        accessory.addService(hap.Service.TemperatureSensor, 'Temperature', 'Temperature');
      }
      if (config.humidity_sensor) {
        accessory.addService(hap.Service.HumiditySensor, 'Humidity', 'Humidity');
      }
      if (config.humidifier) {
        accessory.addService(hap.Service.HumidifierDehumidifier, 'Humidifier', 'Humidifier');
      }

      this.api.registerPlatformAccessories('homebridge-philips-air', 'philipsAir', [accessory]);
    } else {
      let lightsService = accessory.getService('Lights');

      if (config.light_control) {
        if (lightsService == undefined) {
          lightsService = accessory.addService(hap.Service.Lightbulb, 'Lights', 'Lights');
          lightsService.addCharacteristic(hap.Characteristic.Brightness);
        }
      } else if (lightsService != undefined) {
        accessory.removeService(lightsService);
      }
      const WaterLevel = accessory.getService('Water level');
      if (config.water_level) {
        if (WaterLevel == undefined) {
          accessory.addService(hap.Service.LeakSensor, 'Water level', 'Water level');
        }
      } else if (WaterLevel != undefined) {
        accessory.removeService(WaterLevel);
      }
      const temperature_sensor = accessory.getService('Temperature');
      if (config.temperature_sensor) {
        if (temperature_sensor == undefined) {
          accessory.addService(hap.Service.TemperatureSensor, 'Temperature', 'Temperature');
        }
      } else if (temperature_sensor != undefined) {
        accessory.removeService(temperature_sensor);
      }
      const humidity_sensor = accessory.getService('Humidity');
      if (config.humidity_sensor) {
        if (humidity_sensor == undefined) {
          accessory.addService(hap.Service.HumiditySensor, 'Humidity', 'Humidity');
        }
      } else if (humidity_sensor != undefined) {
        accessory.removeService(humidity_sensor);
      }
      const Humidifier = accessory.getService('Humidifier');
      if (config.humidifier) {
        if (Humidifier == undefined) {
          accessory.addService(hap.Service.HumidifierDehumidifier, 'Humidifier', 'Humidifier');
        }
      } else if (Humidifier != undefined) {
        accessory.removeService(Humidifier);
      }
    }

    this.setService(accessory, config);

    let client: AirClient;
    switch (config.protocol) {
      case 'coap':
        client = new CoapClient(config.ip, this.timeout);
        break;
      case 'plain_coap':
        client = new PlainCoapClient(config.ip, this.timeout);
        break;
      case 'http_legacy':
        client = new HttpClientLegacy(config.ip, this.timeout);
        break;
      case 'http':
      default:
        if (accessory.context.key) {
          client = new HttpClient(config.ip, this.timeout, accessory.context.key);
        } else {
          client = new HttpClient(config.ip, this.timeout);
        }
    }

    this.purifiers.set(accessory.displayName, {
      accessory: accessory,
      client: client,
      config: config
    });
  }

  removeAccessories(accessories: Array<PlatformAccessory>): void {
    accessories.forEach(accessory => {
      this.log('[' + accessory.displayName + '] Removed from Homebridge.');
      this.api.unregisterPlatformAccessories('homebridge-philips-air', 'philipsAir', [accessory]);
    });
  }

  setService(accessory: PlatformAccessory, config: DeviceConfig): void {
    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log('[' + accessory.displayName + '] Identify requested.');
    });

    const purifierService = accessory.getService(hap.Service.AirPurifier);
    if (purifierService) {
      const Humidifier = accessory.getService('Humidifier');
      purifierService
        .getCharacteristic(hap.Characteristic.Active)
        .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
          try {
            await this.setPower(accessory, state);
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            Humidifier
              .updateCharacteristic(hap.Characteristic.Active, 0)
              .updateCharacteristic(hap.Characteristic.RotationSpeed, 0)
              .updateCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState, 0)
              .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, 0)
              .updateCharacteristic(hap.Characteristic.RelativeHumidityDehumidifierThreshold, 0)
              .updateCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold, 0);
            callback();
          } catch (err) {
            callback(err);
          }
        })
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetStatus, accessory);
          callback();
        });

      purifierService
        .getCharacteristic(hap.Characteristic.TargetAirPurifierState)
        .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
          try {
            await this.setMode(accessory, state);
            callback();
          } catch (err) {
            callback(err);
          }
        })
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetStatus, accessory);
          callback();
        });

      purifierService
        .getCharacteristic(hap.Characteristic.CurrentAirPurifierState)
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetStatus, accessory);
          callback();
        });

      purifierService
        .getCharacteristic(hap.Characteristic.LockPhysicalControls)
        .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
          try {
            await this.setLock(accessory, state);
            callback();
          } catch (err) {
            callback(err);
          }
        })
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetStatus, accessory);
          callback();
        });

      purifierService
        .getCharacteristic(hap.Characteristic.RotationSpeed)
        .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
          try {
            await this.setFan(accessory, state);
            callback();
          } catch (err) {
            callback(err);
          }
        })
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetStatus, accessory);
          callback();
        });
    }

    const qualitySensor = accessory.getService(hap.Service.AirQualitySensor);
    if (qualitySensor) {
      qualitySensor
        .getCharacteristic(hap.Characteristic.AirQuality)
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetStatus, accessory);
          callback();
        });

      qualitySensor
        .getCharacteristic(hap.Characteristic.PM2_5Density)
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetStatus, accessory);
          callback();
        });
    }

    if (config.light_control) {
      const lightService = accessory.getService('Lights');
      if (lightService) {
        lightService
          .getCharacteristic(hap.Characteristic.On)
          .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            try {
              await this.setLights(accessory, state);
              callback();
            } catch (err) {
              callback(err);
            }
          })
          .on('get', (callback: CharacteristicGetCallback) => {
            this.enqueueAccessory(CommandType.GetStatus, accessory);
            callback();
          });

        lightService
          .getCharacteristic(hap.Characteristic.Brightness)
          .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            try {
              await this.setBrightness(accessory, state);
              callback();
            } catch (err) {
              callback(err);
            }
          })
          .on('get', (callback: CharacteristicGetCallback) => {
            this.enqueueAccessory(CommandType.GetStatus, accessory);
            callback();
          });
      }
    }

    const preFilter = accessory.getService('Pre-filter');
    if (preFilter) {
      preFilter
        .getCharacteristic(hap.Characteristic.FilterChangeIndication)
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetFilters, accessory);
          callback();
        });

      preFilter
        .getCharacteristic(hap.Characteristic.FilterLifeLevel)
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetFilters, accessory);
          callback();
        });
    }

    const carbonFilter = accessory.getService('Active carbon filter');
    if (carbonFilter) {
      carbonFilter
        .getCharacteristic(hap.Characteristic.FilterChangeIndication)
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetFilters, accessory);
          callback();
        });

      carbonFilter
        .getCharacteristic(hap.Characteristic.FilterLifeLevel)
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetFilters, accessory);
          callback();
        });
    }

    const hepaFilter = accessory.getService('HEPA filter');
    if (hepaFilter) {
      hepaFilter
        .getCharacteristic(hap.Characteristic.FilterChangeIndication)
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetFilters, accessory);
          callback();
        });

      hepaFilter
        .getCharacteristic(hap.Characteristic.FilterLifeLevel)
        .on('get', (callback: CharacteristicGetCallback) => {
          this.enqueueAccessory(CommandType.GetFilters, accessory);
          callback();
        });
    }
    if (config.water_level) {
      const WaterLevel = accessory.getService('Water level');
      if (WaterLevel) {
        WaterLevel
          .getCharacteristic(hap.Characteristic.LeakDetected)
          .on('get', (callback: CharacteristicGetCallback) => {
            this.enqueueAccessory(CommandType.GetWaterLevel, accessory);
            callback();
          });
        WaterLevel
          .getCharacteristic(hap.Characteristic.WaterLevel)
          .on('get', (callback: CharacteristicGetCallback) => {
            this.enqueueAccessory(CommandType.GetWaterLevel, accessory);
            callback();
          });
      }
    }
    if (config.temperature_sensor) {
      const temperature_sensor = accessory.getService('Temperature');
      if (temperature_sensor) {
        temperature_sensor
          .getCharacteristic(hap.Characteristic.CurrentTemperature)
          .on('get', (callback: CharacteristicGetCallback) => {
            this.enqueueAccessory(CommandType.GetTemperature, accessory);
            callback();
          });
      }
    }
    if (config.humidity_sensor) {
      const humidity_sensor = accessory.getService('Humidity');
      if (humidity_sensor) {
        humidity_sensor
          .getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
          .on('get', (callback: CharacteristicGetCallback) => {
            this.enqueueAccessory(CommandType.GetHumidity, accessory);
            callback();
          });
      }
    }
    if (config.humidifier) {
      const Humidifier = accessory.getService('Humidifier');
      if (Humidifier) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        Humidifier.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, Humidifier.rh);
        Humidifier
          .getCharacteristic(hap.Characteristic.Active)
          .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            Humidifier
              .updateCharacteristic(hap.Characteristic.Active, 0)
              .updateCharacteristic(hap.Characteristic.RotationSpeed, 0)
              .updateCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState, 0)
              .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, 0)
              .updateCharacteristic(hap.Characteristic.RelativeHumidityDehumidifierThreshold, 0)
              .updateCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold, 0);
            try {
              await this.setHumidity(accessory, state);
              callback();
            } catch (err) {
              callback(err);
            }
          })
          .on('get', (callback: CharacteristicGetCallback) => {
            this.enqueueAccessory(CommandType.GetStatus, accessory);
            callback();
          });
        Humidifier
          .getCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState)
          .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            try {
              await this.setHumidity(accessory, state);
              callback();
            } catch (err) {
              callback(err);
            }
          })
          .on('get', (callback: CharacteristicGetCallback) => {
            this.enqueueAccessory(CommandType.GetStatus, accessory);
            callback();
          });
        Humidifier
          .getCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState)
          .on('get', (callback: CharacteristicGetCallback) => {
            this.enqueueAccessory(CommandType.GetStatus, accessory);
            callback();
          });
        Humidifier
          .getCharacteristic(hap.Characteristic.RotationSpeed)
          .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            try {
              await this.setHumidityTarget(accessory, state);
              callback();
            } catch (err) {
              callback(err);
            }
          })
          .on('get', (callback: CharacteristicGetCallback) => {
            this.enqueueAccessory(CommandType.GetStatus, accessory);
            callback();
          });
        Humidifier
          .getCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold)
          .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            try {
              await this.setHumidityTarget(accessory, state);
              callback();
            } catch (err) {
              callback(err);
            }
          })
          .setProps({
            minValue: 30,
            maxValue: 70,
            minStep: 10
          })
          .on('get', (callback: CharacteristicGetCallback) => {
            this.enqueueAccessory(CommandType.GetStatus, accessory);
            callback();
          });
        Humidifier
          .getCharacteristic(hap.Characteristic.RelativeHumidityDehumidifierThreshold)
          .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            try {
              await this.setHumidityTarget(accessory, state);
              callback();
            } catch (err) {
              callback(err);
            }
          })
          .setProps({
            minValue: 30,
            maxValue: 70,
            minStep: 10
          })
          .on('get', (callback: CharacteristicGetCallback) => {
            this.enqueueAccessory(CommandType.GetStatus, accessory);
            callback();
          });
      }
    }
  }

  enqueueAccessory(commandType: CommandType, accessory: PlatformAccessory): void {
    const purifier = this.purifiers.get(accessory.displayName);

    if (purifier) {
      this.enqueueCommand(commandType, purifier);
    }
  }

  enqueueCommand(commandType: CommandType, purifier: Purifier, data?: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    callback?: (error?: Error | null | undefined) => void): void {
    if (commandType != CommandType.SetData) {
      const exists = this.commandQueue.find((command) => {
        return command.purifier.config.ip == purifier.config.ip && command.type == commandType;
      });
      if (exists) {
        return; // Don't enqueue commands we already have in the queue
      }
    }
    this.commandQueue.push({
      purifier: purifier,
      type: commandType,
      callback: callback,
      data: data
    });
    if (!this.queueRunning) {
      this.queueRunning = true;
      this.nextCommand();
    }
  }

  nextCommand(): void {
    const todoItem = this.commandQueue.shift();
    if (!todoItem) {
      return;
    }

    let command;
    switch (todoItem.type) {
      case CommandType.Polling:
        command = this.updatePolling(todoItem.purifier);
        break;
      case CommandType.GetFirmware:
        command = this.updateFirmware(todoItem.purifier);
        break;
      case CommandType.GetFilters:
        command = this.updateFilters(todoItem.purifier);
        break;
      case CommandType.GetStatus:
        command = this.updateStatus(todoItem.purifier);
        break;
      case CommandType.GetWaterLevel:
        command = this.updateWaterLevel(todoItem.purifier);
        break;
      case CommandType.GetTemperature:
        command = this.updateTemperature(todoItem.purifier);
        break;
      case CommandType.GetHumidity:
        command = this.updateHumidity(todoItem.purifier);
        break;
      case CommandType.SetData:
        command = this.setData(todoItem.purifier, todoItem.data, todoItem.callback);
    }

    command.then(() => {
      if (this.commandQueue.length > 0) {
        this.nextCommand();
      } else {
        this.queueRunning = false;
      }
    });
  }
}

export = (api: API): void => {
  hap = api.hap;
  Accessory = api.platformAccessory;

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PhilipsAirPlatform);
};