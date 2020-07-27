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
import { HttpClient, CoapClient, PlainCoapClient, HttpClientLegacy } from 'philips-air';
import { PhilipsAirPlatformConfig, DeviceConfig } from './configTypes';

let hap: HAP;
let Accessory: typeof PlatformAccessory;

const PLUGIN_NAME = 'homebridge-philips-air';
const PLATFORM_NAME = 'philipsAir';

class PhilipsAirPlatform implements DynamicPlatformPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private readonly config: PhilipsAirPlatformConfig;
  private readonly timeout: number;
  private readonly accessories: Array<PlatformAccessory>;
  private readonly timer?: NodeJS.Timeout;
  private readonly timeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.config = config as unknown as PhilipsAirPlatformConfig;
    this.api = api;

    if (this.config.timeout_seconds) {
      this.timeout = this.config.timeout_seconds * 1000;
    } else {
      this.timeout = 5000;
    }

    this.accessories = [];

    api.on(APIEvent.DID_FINISH_LAUNCHING, this.didFinishLaunching.bind(this));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.setService(accessory);
    this.accessories.push(accessory);
  }

  didFinishLaunching(): void {
    const ips: Array<string> = [];
    this.config.devices.forEach((device: DeviceConfig) => {
      this.addAccessory.bind(this, device)();
      ips.push(device.ip);
    });

    const badAccessories: Array<PlatformAccessory> = [];
    this.accessories.forEach(cachedAccessory => {
      if (!ips.includes(cachedAccessory.context.ip)) {
        badAccessories.push(cachedAccessory);
      }
    });
    this.removeAccessories(badAccessories);

    this.accessories.forEach(accessory => {
      this.updateFirmware(accessory);
      this.updateStatus(accessory);
      this.updateFilters(accessory);
    });
  }

  setData(accessory: PlatformAccessory, values: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      accessory.context.client.setValues(values);
    } catch (err) {
      this.log(err);
    }
  }

  fetchFirmware(accessory: PlatformAccessory): any { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!accessory.context.lastfirmware || Date.now() - accessory.context.lastfirmware > 1000) {
      accessory.context.lastfirmware = Date.now();
      accessory.context.firmware = accessory.context.client.getFirmware();

      accessory.context.firmware.name = accessory.context.firmware.name.replace('_', '/');
    }

    return accessory.context.firmware;
  }

  updateFirmware(accessory: PlatformAccessory): void {
    const accInfo = accessory.getService(hap.Service.AccessoryInformation);
    if (accInfo) {
      accInfo
        .updateCharacteristic(hap.Characteristic.Manufacturer, 'Philips')
        .updateCharacteristic(hap.Characteristic.SerialNumber, accessory.context.ip);
    }

    try {
      const firmware = this.fetchFirmware(accessory);
      if (accInfo) {
        accInfo.updateCharacteristic(hap.Characteristic.Model, firmware.name)
          .updateCharacteristic(hap.Characteristic.FirmwareRevision, firmware.version);
      }
    } catch (err) {
      this.log('Unable to load firmware info: ' + err);
    }
  }

  fetchFilters(accessory: PlatformAccessory): any { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!accessory.context.lastfilters || Date.now() - accessory.context.lastfilters > 1000) {
      accessory.context.lastfilters = Date.now();
      accessory.context.filters = accessory.context.client.getFilters();

      accessory.context.filters.fltsts0change = accessory.context.filters.fltsts0 == 0;
      accessory.context.filters.fltsts0life = accessory.context.filters.fltsts0 / 360 * 100;
      accessory.context.filters.fltsts2change = accessory.context.filters.fltsts2 == 0;
      accessory.context.filters.fltsts2life = accessory.context.filters.fltsts2 / 2400 * 100;
      accessory.context.filters.fltsts1change = accessory.context.filters.fltsts1 == 0;
      accessory.context.filters.fltsts1life = accessory.context.filters.fltsts1 / 4800 * 100;
    }

    return accessory.context.filters;
  }

  updateFilters(accessory: PlatformAccessory): void {
    try {
      const filters = this.fetchFilters(accessory);
      const preFilter = accessory.getService('Pre-filter');
      if (preFilter) {
        preFilter
          .updateCharacteristic(hap.Characteristic.FilterChangeIndication, filters.fltsts0change)
          .updateCharacteristic(hap.Characteristic.FilterLifeLevel, filters.fltsts0life);
      }
      const carbonFilter = accessory.getService('Active carbon filter');
      if (carbonFilter) {
        carbonFilter
          .updateCharacteristic(hap.Characteristic.FilterChangeIndication, filters.fltsts2change)
          .updateCharacteristic(hap.Characteristic.FilterLifeLevel, filters.fltsts2life);
      }
      const hepaFilter = accessory.getService('HEPA filter');
      if (hepaFilter) {
        hepaFilter
          .updateCharacteristic(hap.Characteristic.FilterChangeIndication, filters.fltsts1change)
          .updateCharacteristic(hap.Characteristic.FilterLifeLevel, filters.fltsts1life);
      }
    } catch (err) {
      this.log('Unable to load filter info: ' + err);
    }
  }

  fetchStatus(accessory: PlatformAccessory): any { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!accessory.context.laststatus || Date.now() - accessory.context.laststatus > 1000) {
      accessory.context.laststatus = Date.now();
      accessory.context.status = accessory.context.client.getStatus();

      accessory.context.status.mode = !(accessory.context.status.mode == 'M');
      accessory.context.status.iaql = Math.ceil(accessory.context.status.iaql / 3);
      accessory.context.status.status = accessory.context.status.pwr * 2;

      if (accessory.context.status.pwr == '1') {
        if (!accessory.context.status.mode) {
          if (accessory.context.status.om == 't') {
            accessory.context.status.om = 100;
          } else if (accessory.context.status.om == 's') {
            accessory.context.status.om = 20;
          } else {
            let divisor = 25;
            let offset = 0;
            if (accessory.context.sleep_speed) {
              divisor = 20;
              offset = 1;
            }
            accessory.context.status.om = (accessory.context.status.om + offset) * divisor;
          }
        } else {
          accessory.context.status.om = 0;
        }
      }
    }

    return accessory.context.status;
  }

  updateStatus(accessory: PlatformAccessory): void {
    try {
      const status = this.fetchStatus(accessory);

      const purifierService = accessory.getService(hap.Service.AirPurifier);
      if (purifierService) {
        purifierService
          .updateCharacteristic(hap.Characteristic.Active, status.pwr)
          .updateCharacteristic(hap.Characteristic.TargetAirPurifierState, status.mode)
          .updateCharacteristic(hap.Characteristic.CurrentAirPurifierState, status.status)
          .updateCharacteristic(hap.Characteristic.LockPhysicalControls, status.cl)
          .updateCharacteristic(hap.Characteristic.RotationSpeed, status.om);
      }

      const qualityService = accessory.getService(hap.Service.AirQualitySensor);
      if (qualityService) {
        qualityService
          .updateCharacteristic(hap.Characteristic.AirQuality, status.iaql)
          .updateCharacteristic(hap.Characteristic.PM2_5Density, status.pm25);
      }

      if (accessory.context.light_control) {
        const lightService = accessory.getService(hap.Service.Lightbulb);
        if (lightService) {
          lightService
            .updateCharacteristic(hap.Characteristic.On, status.uil)
            .updateCharacteristic(hap.Characteristic.Brightness, status.aqil);
        }
      }
    } catch (err) {
      this.log('Unable to load status info: ' + err);
      accessory.context.startup = false;
    }
  }

  setPower(accessory: PlatformAccessory, state: CharacteristicValue, callback: CharacteristicSetCallback): void {
    try {
      const values = {
        pwr: (state as boolean).toString()
      };

      this.setData(accessory, values);

      const purifierService = accessory.getService(hap.Service.AirPurifier);
      if (purifierService) {
        purifierService.updateCharacteristic(hap.Characteristic.CurrentAirPurifierState, state as number * 2);
      }

      if (accessory.context.light_control) {
        const lights = accessory.getService(accessory.context.name + ' Lights');
        const buttons = accessory.getService(accessory.context.name + ' Buttons');
        if (state) {
          if (lights) {
            lights.updateCharacteristic(hap.Characteristic.On, accessory.context.status.aqil > 0);
            lights.updateCharacteristic(hap.Characteristic.Brightness, accessory.context.status.iaql);
          }
          if (buttons) {
            buttons.updateCharacteristic(hap.Characteristic.On, accessory.context.status.uil);
          }
        } else {
          if (lights) {
            lights.updateCharacteristic(hap.Characteristic.On, false);
          }
          if (buttons) {
            buttons.updateCharacteristic(hap.Characteristic.On, false);
          }
        }
      }

      callback();
    } catch (err) {
      callback(err);
    }
  }

  setLights(accessory: PlatformAccessory, state: CharacteristicValue, callback: CharacteristicSetCallback): void {
    try {
      const values = {
        aqil: state ? accessory.context.status.aqil : 0
      };

      this.setData(accessory, values);

      callback();
    } catch (err) {
      callback(err);
    }
  }

  setBrightness(accessory: PlatformAccessory, state: CharacteristicValue, callback: CharacteristicSetCallback): void {
    try {
      const values = {
        aqil: state
      };

      this.setData(accessory, values);

      callback();
    } catch (err) {
      callback(err);
    }
  }

  setButtons(accessory: PlatformAccessory, state: CharacteristicValue, callback: CharacteristicSetCallback): void {
    try {
      const values = {
        uil: state ? '1' : '0'
      };

      this.setData(accessory, values);

      callback();
    } catch (err) {
      callback(err);
    }
  }

  setMode(accessory: PlatformAccessory, state: CharacteristicValue, callback: CharacteristicSetCallback): void {
    try {
      const values = {
        mode: state ? 'P' : 'M'
      };

      if (state != 0) {
        const purifierService = accessory.getService(hap.Service.AirPurifier);
        if (purifierService) {
          purifierService.updateCharacteristic(hap.Characteristic.RotationSpeed, 0);
        }
      }

      this.setData(accessory, values);

      callback();
    } catch (err) {
      callback(err);
    }
  }

  setLock(accessory: PlatformAccessory, state: CharacteristicValue, callback: CharacteristicSetCallback): void {
    try {
      const values = {
        cl: state == 1
      };

      this.setData(accessory, values);

      callback();
    } catch (err) {
      callback(err);
    }
  }

  setFan(accessory: PlatformAccessory, state: CharacteristicValue, callback: CharacteristicSetCallback): void {
    try {
      let divisor = 25;
      let offset = 0;
      if (accessory.context.sleep_speed) {
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
        this.setData(accessory, values);

        const service = accessory.getService(hap.Service.AirPurifier);
        if (service) {
          service.updateCharacteristic(hap.Characteristic.TargetAirPurifierState, 0);
        }

        const oldTimeout = this.timeouts.get(accessory.context.ip);
        if (oldTimeout) {
          clearTimeout(oldTimeout);
          this.timeouts.delete(accessory.context.ip);
        }
        const newTimeout = setTimeout(() => {
          if (service) {
            service.updateCharacteristic(hap.Characteristic.RotationSpeed, speed * divisor);
          }
          this.timeouts.delete(accessory.context.ip);
        }, 1000);
        this.timeouts.set(accessory.context.ip, newTimeout);
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }

  addAccessory(data: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.log('Initializing platform accessory ' + data.name + '...');

    let accessory = this.accessories.find(cachedAccessory => {
      return cachedAccessory.context.ip == data.ip;
    });

    if (!accessory) {
      const uuid = hap.uuid.generate(data.ip);
      accessory = new Accessory(data.name, uuid);

      accessory.context.name = data.name;
      accessory.context.ip = data.ip;
      accessory.context.protocol = data.protocol;
      accessory.context.sleep_speed = data.sleep_speed;
      accessory.context.light_control = data.light_control;

      accessory.addService(hap.Service.AirPurifier, data.name);
      accessory.addService(hap.Service.AirQualitySensor, data.name);

      if (accessory.context.light_control) {
        accessory.addService(hap.Service.Lightbulb, data.name + ' Lights')
          .addCharacteristic(hap.Characteristic.Brightness);
        accessory.addService(hap.Service.Lightbulb, data.name + ' Buttons', data.name + ' Buttons');
      }

      accessory.addService(hap.Service.FilterMaintenance, 'Pre-filter', 'Pre-filter');
      accessory.addService(hap.Service.FilterMaintenance, 'Active carbon filter', 'Active carbon filter');
      accessory.addService(hap.Service.FilterMaintenance, 'HEPA filter', 'HEPA filter');

      this.setService(accessory);

      this.api.registerPlatformAccessories('homebridge-philips-air', 'philipsAir', [accessory]);

      this.accessories.push(accessory);
    } else {
      accessory.context.protocol = data.protocol;
      accessory.context.sleep_speed = data.sleep_speed;
      accessory.context.light_control = data.light_control;

      let lights = accessory.getService(data.name + ' Lights');
      let buttons = accessory.getService(data.name + ' Buttons');

      if (accessory.context.light_control) {
        if (lights == undefined) {
          lights = accessory.addService(hap.Service.Lightbulb, data.name + ' Lights', data.name + ' Lights');
          lights.addCharacteristic(hap.Characteristic.Brightness);
        }
        if (buttons == undefined) {
          buttons = accessory.addService(hap.Service.Lightbulb, data.name + ' Buttons', data.name + ' Buttons');
        }
      } else {
        if (lights != undefined) {
          accessory.removeService(lights);
        }
        if (buttons != undefined) {
          accessory.removeService(buttons);
        }
      }
    }

    switch (accessory.context.protocol) {
      case 'coap':
        accessory.context.client = new CoapClient(accessory.context.ip, this.timeout);
        break;
      case 'plain_coap':
        accessory.context.client = new PlainCoapClient(accessory.context.ip, this.timeout);
        break;
      case 'http_legacy':
        accessory.context.client = new HttpClientLegacy(accessory.context.ip, this.timeout);
        break;
      case 'http':
      default:
        if (accessory.context.client?.key) {
          accessory.context.client = new HttpClient(accessory.context.ip, this.timeout, accessory.context.client.key);
        } else {
          accessory.context.client = new HttpClient(accessory.context.ip, this.timeout);
        }
    }
  }

  removeAccessories(accessories: Array<PlatformAccessory>): void {
    accessories.forEach(accessory => {
      this.log(accessory.context.name + ' is removed from HomeBridge.');
      this.api.unregisterPlatformAccessories('homebridge-philips-air', 'philipsAir', [accessory]);
      this.accessories.splice(this.accessories.indexOf(accessory), 1);
    });
  }

  setService(accessory: PlatformAccessory): void {
    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log(accessory.context.name + ' identify requested!');
    });

    const purifierService = accessory.getService(hap.Service.AirPurifier);
    if (purifierService) {
      purifierService
        .getCharacteristic(hap.Characteristic.Active)
        .on('set', this.setPower.bind(this, accessory))
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const status = this.fetchStatus(accessory);
            callback(null, status.pwr);
          } catch (err) {
            callback(err);
          }
        });

      purifierService
        .getCharacteristic(hap.Characteristic.TargetAirPurifierState)
        .on('set', this.setMode.bind(this, accessory))
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const status = this.fetchStatus(accessory);
            callback(null, status.mode);
          } catch (err) {
            callback(err);
          }
        });

      purifierService
        .getCharacteristic(hap.Characteristic.CurrentAirPurifierState)
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const status = this.fetchStatus(accessory);
            callback(null, status.status);
          } catch (err) {
            callback(err);
          }
        });

      purifierService
        .getCharacteristic(hap.Characteristic.LockPhysicalControls)
        .on('set', this.setLock.bind(this, accessory))
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const status = this.fetchStatus(accessory);
            callback(null, status.cl);
          } catch (err) {
            callback(err);
          }
        });

      purifierService
        .getCharacteristic(hap.Characteristic.RotationSpeed)
        .on('set', this.setFan.bind(this, accessory))
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const status = this.fetchStatus(accessory);
            callback(null, status.om);
          } catch (err) {
            callback(err);
          }
        });
    }

    const qualitySensor = accessory.getService(hap.Service.AirQualitySensor);
    if (qualitySensor) {
      qualitySensor
        .getCharacteristic(hap.Characteristic.AirQuality)
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const status = this.fetchStatus(accessory);
            callback(null, status.iaql);
          } catch (err) {
            callback(err);
          }
        });

      qualitySensor
        .getCharacteristic(hap.Characteristic.PM2_5Density)
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const status = this.fetchStatus(accessory);
            callback(null, status.pm25);
          } catch (err) {
            callback(err);
          }
        });
    }

    if (accessory.context.light_control) {
      const lightService = accessory.getService(accessory.context.name + ' Lights');
      if (lightService) {
        lightService
          .getCharacteristic(hap.Characteristic.On)
          .on('set', this.setLights.bind(this, accessory))
          .on('get', (callback: CharacteristicGetCallback) => {
            try {
              const status = this.fetchStatus(accessory);
              callback(null, status.aqil > 0);
            } catch (err) {
              callback(err);
            }
          });

        lightService
          .getCharacteristic(hap.Characteristic.Brightness)
          .on('set', this.setBrightness.bind(this, accessory))
          .on('get', (callback: CharacteristicGetCallback) => {
            try {
              const status = this.fetchStatus(accessory);
              callback(null, status.aqil);
            } catch (err) {
              callback(err);
            }
          });
      }

      const buttonService = accessory.getService(accessory.context.name + ' Buttons');
      if (buttonService) {
        buttonService
          .getCharacteristic(hap.Characteristic.On)
          .on('set', this.setButtons.bind(this, accessory))
          .on('get', (callback: CharacteristicGetCallback) => {
            try {
              const status = this.fetchStatus(accessory);
              callback(null, status.uil);
            } catch (err) {
              callback(err);
            }
          });
      }
    }

    const preFilter = accessory.getService('Pre-filter');
    if (preFilter) {
      preFilter
        .getCharacteristic(hap.Characteristic.FilterChangeIndication)
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const filters = this.fetchFilters(accessory);
            callback(null, filters.fltsts0change);
          } catch (err) {
            callback(err);
          }
        });

      preFilter
        .getCharacteristic(hap.Characteristic.FilterLifeLevel)
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const filters = this.fetchFilters(accessory);
            callback(null, filters.fltsts0life);
          } catch (err) {
            callback(err);
          }
        });
    }

    const carbonFilter = accessory.getService('Active carbon filter');
    if (carbonFilter) {
      carbonFilter
        .getCharacteristic(hap.Characteristic.FilterChangeIndication)
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const filters = this.fetchFilters(accessory);
            callback(null, filters.fltsts2change);
          } catch (err) {
            callback(err);
          }
        });

      carbonFilter
        .getCharacteristic(hap.Characteristic.FilterLifeLevel)
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const filters = this.fetchFilters(accessory);
            callback(null, filters.fltsts2life);
          } catch (err) {
            callback(err);
          }
        });
    }

    const hepaFilter = accessory.getService('HEPA filter');
    if (hepaFilter) {
      hepaFilter
        .getCharacteristic(hap.Characteristic.FilterChangeIndication)
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const filters = this.fetchFilters(accessory);
            callback(null, filters.fltsts1change);
          } catch (err) {
            callback(err);
          }
        });

      hepaFilter
        .getCharacteristic(hap.Characteristic.FilterLifeLevel)
        .on('get', (callback: CharacteristicGetCallback) => {
          try {
            const filters = this.fetchFilters(accessory);
            callback(null, filters.fltsts1life);
          } catch (err) {
            callback(err);
          }
        });
    }
  }
}

export = (api: API): void => {
  hap = api.hap;
  Accessory = api.platformAccessory;

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PhilipsAirPlatform);
};
