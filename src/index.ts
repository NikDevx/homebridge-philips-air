import {
  API,
  APIEvent,
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
import {exec} from 'child_process';
import * as fs from 'fs';
import timestamp from 'time-stamp';
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
  uil?: string,
  rh?: number,
  rhset?: number,
  func?: string
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
      // Polling interval
      let polling = purifier.config.polling || 1800;
      if (polling < 900) {
        polling = 900;
      }
      setInterval(function() {
        exec('python3 /usr/lib/node_modules/homebridge-philips-air/node_modules/philips-air/pyaircontrol.py --ipaddr ' + purifier.config.ip + ' --protocol coap --status', (error, stdout, stderr) => {
          if (error || stderr) {
            console.log(timestamp('[DD.MM.YYYY, HH:mm:ss] ') + '\x1b[36m[Philips Air] \x1b[31m[' + purifier.config.name + '] Unable to get data for polling: Error: spawnSync python3 ETIMEDOUT.\x1b[0m');
            console.log(timestamp('[DD.MM.YYYY, HH:mm:ss] ') + '\x1b[33mIf your have "Error: spawnSync python3 ETIMEDOUT" your need unplug the accessory from outlet for 10 seconds and plug again.\x1b[0m');
          }

          if (error || stderr || error && stderr) {
            stdout = '{"om": "1", "pwr": "0", "cl": false, "aqil": 0, "uil": "0", "dt": 0, "dtrs": 0, "mode": "A", "func": "PH", "rhset": 40, "rh": 0, "temp": 0, "pm25": 2, "iaql": 1, "aqit": 4, "ddp": "1", "rddp": "1", "err": 0, "wl": 100}';
          }
          const obj = JSON.parse(stdout);
          // console.log('Polling in process ' + obj.rh);
          const purifierService = purifier.accessory.getService(hap.Service.AirPurifier);
          if (purifierService) {
            const state = parseInt(obj.pwr) * 2;


            purifierService
              .updateCharacteristic(hap.Characteristic.Active, obj.pwr)
              .updateCharacteristic(hap.Characteristic.CurrentAirPurifierState, state)
              .updateCharacteristic(hap.Characteristic.LockPhysicalControls, obj.cl);
          }
          const qualityService = purifier.accessory.getService(hap.Service.AirQualitySensor);
          if (qualityService) {
            const iaql = Math.ceil(obj.iaql / 3);
            qualityService
              .updateCharacteristic(hap.Characteristic.AirQuality, iaql)
              .updateCharacteristic(hap.Characteristic.PM2_5Density, obj.pm25);
          }
          if (purifier.config.temperature_sensor) {
            const temperature_sensor = purifier.accessory.getService('Temperature');
            if (temperature_sensor) {
              temperature_sensor.updateCharacteristic(hap.Characteristic.CurrentTemperature, obj.temp);
            }
          }
          if (purifier.config.humidity_sensor) {
            const humidity_sensor = purifier.accessory.getService('Humidity');
            if (humidity_sensor) {
              humidity_sensor.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, obj.rh);
            }
          }
          if (purifier.config.light_control) {
            const lightsService = purifier.accessory.getService('Lights');
            if (obj.pwr == '1') {
              if (lightsService) {
                lightsService
                  .updateCharacteristic(hap.Characteristic.On, obj.aqil > 0)
                  .updateCharacteristic(hap.Characteristic.Brightness, obj.aqil);
              }
            }
          }
          if (purifier.config.humidifier) {
            let water_level = 100;
            let speed_humidity = 0;
            if (obj.func == 'PH' && obj.wl == 0) {
              water_level = 0;
            }
            if (obj.pwr == '1') {
              if (obj.func == 'PH' && water_level == 100) {
                if (obj.rhset == 40) {
                  speed_humidity = 25;
                } else if (obj.rhset == 50) {
                  speed_humidity = 50;
                } else if (obj.rhset == 60) {
                  speed_humidity = 75;
                } else if (obj.rhset == 70) {
                  speed_humidity = 100;
                }
              }
            }
            const Humidifier = purifier.accessory.getService('Humidifier');
            if (Humidifier) {
              Humidifier
                .updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, obj.rh)
                .updateCharacteristic(hap.Characteristic.WaterLevel, water_level)
                .updateCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState, 1)
                .updateCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold, speed_humidity);
              if (water_level == 0) {
                if (obj.func != 'P') {
                  exec('airctrl --ipaddr ' + purifier.config.ip + ' --protocol coap --func P', (error, stdout, stderr) => {
                    if (error || stderr) {
                      console.log(timestamp('[DD.MM.YYYY, HH:mm:ss] ') + '\x1b[36m[Philips Air] \x1b[31m[' + purifier.config.name + '] Unable to get data for polling: Error: spawnSync python3 ETIMEDOUT.\x1b[0m');
                      console.log(timestamp('[DD.MM.YYYY, HH:mm:ss] ') + '\x1b[33mIf your have "Error: spawnSync python3 ETIMEDOUT" your need unplug the accessory from outlet for 10 seconds and plug again.\x1b[0m');
                    }
                  });
                }
                Humidifier
                  .updateCharacteristic(hap.Characteristic.Active, 0)
                  .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, 0)
                  .updateCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold, 0);
              }
            }
          }
          if (purifier.config.logger) {
            if (purifier.config.temperature_sensor) {
              const logger_temp = fs.createWriteStream('/usr/lib/node_modules/homebridge-philips-air/sensor/temp.txt', {
                flags: 'w'
              });
              if (!error || !stderr || !error && !stderr) {
                logger_temp.write(obj.temp.toString());
                logger_temp.end();
              }
            }
            if (purifier.config.humidity_sensor) {
              const logger_hum = fs.createWriteStream('/usr/lib/node_modules/homebridge-philips-air/sensor/hum.txt', {
                flags: 'w'
              });
              if (!error || !stderr || !error && !stderr) {
                logger_hum.write(obj.rh.toString());
                logger_hum.end();
              }
            }
          }
        });
      }, polling * 1000);
    } catch (err) {
      this.log.error('[' + purifier.config.name + '] Unable to load polling info');
    }
  }

  async updateFirmware(purifier: Purifier): Promise<void> {
    try {
      purifier.lastfirmware = Date.now();
      const firmware: PurifierFirmware = await purifier.client?.getFirmware();
      await this.storeKey(purifier);
      const accInfo = purifier.accessory.getService(hap.Service.AccessoryInformation);
      if (accInfo) {
        const name = firmware.modelid;

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

  async updateFilters(purifier: Purifier): Promise<void> {
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
        const fltsts2life = filters.fltsts2 / 4800 * 100;

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
      if (purifier.config.humidifier) {
        const wickFilter = purifier.accessory.getService('Wick filter');
        if (wickFilter) {
          const fltwickchange = filters.wicksts == 0;
          const fltwicklife = Math.round(filters.wicksts / 4800 * 100);
          wickFilter
            .updateCharacteristic(hap.Characteristic.FilterChangeIndication, fltwickchange)
            .updateCharacteristic(hap.Characteristic.FilterLifeLevel, fltwicklife);
        }
      }
    } catch (err) {
      this.log.error('[' + purifier.config.name + '] Unable to load filter info: ' + err);
    }
  }

  async updateStatus(purifier: Purifier): Promise<void> {
    try {
      const status: PurifierStatus = await purifier.client?.getStatus();
      purifier.laststatus = Date.now();
      await this.storeKey(purifier);
      const purifierService = purifier.accessory.getService(hap.Service.AirPurifier);
      if (purifierService) {
        const state = parseInt(status.pwr) * 2;

        purifierService
          .updateCharacteristic(hap.Characteristic.Active, status.pwr)
          .updateCharacteristic(hap.Characteristic.CurrentAirPurifierState, state)
          .updateCharacteristic(hap.Characteristic.LockPhysicalControls, status.cl);
      }
      const qualityService = purifier.accessory.getService(hap.Service.AirQualitySensor);
      if (qualityService) {
        const iaql = Math.ceil(status.iaql / 3);
        qualityService
          .updateCharacteristic(hap.Characteristic.AirQuality, iaql)
          .updateCharacteristic(hap.Characteristic.PM2_5Density, status.pm25);
      }
      if (purifier.config.temperature_sensor) {
        const temperature_sensor = purifier.accessory.getService('Temperature');
        if (temperature_sensor) {
          temperature_sensor.updateCharacteristic(hap.Characteristic.CurrentTemperature, status.temp);
        }
      }
      if (purifier.config.humidity_sensor) {
        const humidity_sensor = purifier.accessory.getService('Humidity');
        if (humidity_sensor) {
          humidity_sensor.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, status.rh);
        }
      }

      if (purifier.config.light_control) {
        const lightsService = purifier.accessory.getService('Lights');
        if (status.pwr == '1') {
          if (lightsService) {
            lightsService
              .updateCharacteristic(hap.Characteristic.On, status.aqil > 0)
              .updateCharacteristic(hap.Characteristic.Brightness, status.aqil);
          }
        }
      }
      if (purifier.config.humidifier) {
        const Humidifier = purifier.accessory.getService('Humidifier');
        if (Humidifier) {
          let speed_humidity = 0;
          let state_ph = 0;
          let water_level = 100;
          if (status.func == 'PH' && status.wl == 0) {
            water_level = 0;
          }
          if (status.pwr == '1') {
            if (status.func == 'PH' && water_level == 100) {
              state_ph = 1;
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
          }
          Humidifier
            .updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, status.rh)
            .updateCharacteristic(hap.Characteristic.WaterLevel, water_level)
            .updateCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState, 1);
          if (state_ph && status.rhset >= 40) {
            Humidifier
              .updateCharacteristic(hap.Characteristic.Active, state_ph)
              .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, state_ph * 2)
              .updateCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold, speed_humidity);
          }
          if (water_level == 0) {
            if (status.func != 'P') {
              exec('airctrl --ipaddr ' + purifier.config.ip + ' --protocol coap --func P', (err, stdout, stderr) => {
                if (err) {
                  return;
                }
                if (stderr) {
                  console.error('Unable to switch off purifier ' + stderr + '. If your have "sync timeout" error your need unplug the accessory from the outlet for 10 seconds.');
                }
              });
            }
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
        pwr: (state as boolean).toString()
      };
      try {
        const status: PurifierStatus = await purifier.client?.getStatus();
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        purifier.laststatus = Date.now();
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await this.storeKey(purifier);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        let water_level = 100;
        if (status.func == 'PH' && status.wl == 0) {
          water_level = 0;
        }
        const purifierService = accessory.getService(hap.Service.AirPurifier);
        if (purifierService) {
          purifierService.updateCharacteristic(hap.Characteristic.CurrentAirPurifierState, state as number * 2);
        }
        if (purifier.config.humidifier) {
          if (water_level == 0) {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
            values['func'] = 'P';
          }
        }
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await this.enqueuePromise(CommandType.SetData, purifier, values);
        if (purifier.config.light_control) {
          const lightsService = accessory.getService('Lights');
          if (lightsService) {
            if (state) {
              lightsService
                .updateCharacteristic(hap.Characteristic.On, status.aqil > 0)
                .updateCharacteristic(hap.Characteristic.Brightness, status.aqil);
            } else {
              lightsService
                .updateCharacteristic(hap.Characteristic.On, 0)
                .updateCharacteristic(hap.Characteristic.Brightness, 0);
            }
          }
        }
        if (purifier.config.humidifier) {
          const Humidifier = accessory.getService('Humidifier');
          let state_ph = 0;
          if (status.func == 'PH' && water_level == 100) {
            state_ph = 1;
          }
          if (Humidifier) {
            Humidifier.updateCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState, 1);
            if (state) {
              Humidifier
                .updateCharacteristic(hap.Characteristic.Active, state_ph)
                .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, state_ph * 2);
            } else {
              Humidifier
                .updateCharacteristic(hap.Characteristic.Active, 0)
                .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, 0)
                .updateCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold, 0);
            }
          }
        }
      } catch (err) {
        this.log.error('[' + purifier.config.name + '] Error setting power: ' + err);
      }
    }
  }

  async setBrightness(accessory: PlatformAccessory, state: CharacteristicValue): Promise<void> {
    const purifier = this.purifiers.get(accessory.displayName);

    if (purifier) {
      const values = {
        aqil: state,
        uil: state ? '1' : '0'
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
        mode: state ? 'P' : 'M'
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
            purifierService
              .updateCharacteristic(hap.Characteristic.RotationSpeed, 0)
              .updateCharacteristic(hap.Characteristic.TargetAirPurifierState, state);
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
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const status: PurifierStatus = await purifier.client?.getStatus();
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    purifier.laststatus = Date.now();
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    await this.storeKey(purifier);
    const Humidifier = accessory.getService('Humidifier');
    if (purifier) {
      const values = {
        func: state ? 'PH' : 'P'
      };
      let water_level = 100;
      if (status.func == 'PH' && status.wl == 0) {
        water_level = 0;
      }
      let speed_humidity = 0;
      let state_ph = 0;
      if (status.func == 'PH' && water_level == 100) {
        state_ph = 1;
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
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await this.enqueuePromise(CommandType.SetData, purifier, values);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        Humidifier.updateCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState, 1);
        if (state) {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
          Humidifier
            .updateCharacteristic(hap.Characteristic.Active, 1)
            .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, state_ph * 2)
            .updateCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold, speed_humidity);
        } else {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
          Humidifier
            .updateCharacteristic(hap.Characteristic.Active, 0)
            .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, 0)
            .updateCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold, 0);
        }
      } catch (err) {
        this.log.error('[' + purifier.config.name + '] Error setting func: ' + err);
      }
    }
  }

  async setHumidityTarget(accessory: PlatformAccessory, state: CharacteristicValue): Promise<void> {
    const purifier = this.purifiers.get(accessory.displayName);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const status: PurifierStatus = await purifier.client?.getStatus();
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    purifier.laststatus = Date.now();
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    await this.storeKey(purifier);
    const Humidifier = accessory.getService('Humidifier');
    if (purifier) {
      const speed = state;
      const values = {
        func: state ? 'PH' : 'P',
        rhset: 40
      };
      let speed_humidity = 0;
      if (speed > 0 && speed <= 25) {
        values.rhset = 40;
        speed_humidity = 25;
      } else if (speed > 25 && speed <= 50) {
        values.rhset = 50;
        speed_humidity = 50;
      } else if (speed > 50 && speed <= 75) {
        values.rhset = 60;
        speed_humidity = 75;
      } else if (speed > 75 && speed <= 100) {
        values.rhset = 70;
        speed_humidity = 100;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await this.enqueuePromise(CommandType.SetData, purifier, values);
        if (Humidifier) {
          let water_level = 100;
          if (status.func == 'PH' && status.wl == 0) {
            water_level = 0;
          }
          Humidifier.updateCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState, 1);
          if (speed_humidity > 0) {
            Humidifier
              .updateCharacteristic(hap.Characteristic.Active, 1)
              .updateCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState, 2)
              .updateCharacteristic(hap.Characteristic.WaterLevel, water_level)
              .updateCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold, speed_humidity);
          } else {
            Humidifier
              .updateCharacteristic(hap.Characteristic.Active, 0);
          }
        }
      } catch (err) {
        this.log.error('[' + purifier.config.name + '] Error setting humidifier: ' + err);
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
      accessory.addService(hap.Service.AirQualitySensor, 'Air quality', 'Air quality');

      if (config.light_control) {
        accessory.addService(hap.Service.Lightbulb, 'Lights', 'Lights')
          .addCharacteristic(hap.Characteristic.Brightness);
      }

      accessory.addService(hap.Service.FilterMaintenance, 'Pre-filter', 'Pre-filter');
      accessory.addService(hap.Service.FilterMaintenance, 'Active carbon filter', 'Active carbon filter');
      accessory.addService(hap.Service.FilterMaintenance, 'HEPA filter', 'HEPA filter');
      if (config.temperature_sensor) {
        accessory.addService(hap.Service.TemperatureSensor, 'Temperature', 'Temperature');
      }
      if (config.humidity_sensor) {
        accessory.addService(hap.Service.HumiditySensor, 'Humidity', 'Humidity');
      }
      if (config.humidifier) {
        accessory.addService(hap.Service.HumidifierDehumidifier, 'Humidifier', 'Humidifier');
        accessory.addService(hap.Service.FilterMaintenance, 'Wick filter', 'Wick filter');
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
    let min_step_purifier_speed = 25;
    if (config.sleep_speed) {
      min_step_purifier_speed = 20;
    }
    if (purifierService) {
      purifierService
        .getCharacteristic(hap.Characteristic.Active)
        .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
          try {
            await this.setPower(accessory, state);
            callback();
          } catch (err) {
            callback(err);
          }
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
        }).setProps({
          minValue: 0,
          maxValue: 100,
          minStep: min_step_purifier_speed
        });
    }

    if (config.light_control) {
      const lightService = accessory.getService('Lights');
      if (lightService) {
        lightService
          .getCharacteristic(hap.Characteristic.Brightness)
          .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            try {
              await this.setBrightness(accessory, state);
              callback();
            } catch (err) {
              callback(err);
            }
          }).setProps({
            minValue: 0,
            maxValue: 100,
            minStep: 25
          });
      }
    }

    if (config.humidifier) {
      const Humidifier = accessory.getService('Humidifier');
      if (Humidifier) {
        Humidifier
          .getCharacteristic(hap.Characteristic.Active)
          .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            try {
              await this.setHumidity(accessory, state);
              callback();
            } catch (err) {
              callback(err);
            }
          });
        Humidifier
          .getCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState)
          .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            try {
              await this.setHumidityTarget(accessory, state);
              await this.setHumidity(accessory, state);
              callback();
            } catch (err) {
              callback(err);
            }
          }).setProps({
            validValues: [
              hap.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
              hap.Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING
            ]
          });
        Humidifier
          .getCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState)
          .on('set', async(state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            try {
              await this.setHumidityTarget(accessory, state);
              await this.setHumidity(accessory, state);
              callback();
            } catch (err) {
              callback(err);
            }
          }).setProps({
            validValues: [
              hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER
            ]
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
          }).setProps({
            minValue: 0,
            maxValue: 100,
            minStep: 25
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