const fetch = require('sync-fetch')
const python = require('node-calls-python').interpreter;
var Accessory, Service, Characteristic, UUIDGen;

G = parseInt('A4D1CBD5C3FD34126765A442EFB99905F8104DD258AC507FD6406CFF14266D31266FEA1E5C41564B777E690F5504F213160217B4B01B886A5E91547F9E2749F4D7FBD7D3B9A92EE1909D0D2263F80A76A6A24C087A091F531DBF0A0169B6A28AD662A4D18E73AFA32D779D5918D08BC8858F4DCEF97C2A24855E6EEB22B3B2E5', 16);
P = parseInt('B10B8F96A080E01DDE92DE5EAE5D54EC52C99FBCFB06A3C69A6A9DCA52D23B616073E28675A23D189838EF1E2EE652C013ECB4AEA906112324975C3CD49B83BFACCBDD7D90C4BD7098488E9C219A73724EFFD6FAE5644738FAA31A4FF55BCCC0A151AF5F0DC8B4BD45BF37DF365C1A65E68CFDA76D4DA708DF1FB2BC2E4A4371', 16);

module.exports = function(homebridge) {
    Accessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;

    homebridge.registerPlatform('homebridge-philips-air', 'philipsAir', philipsAir, true);
}

function philipsAir(log, config, api) {
    this.log = log;
    this.config = config;

    this.libpython = config.libpython || 'python3.7m';

    this.accessories = [];

    python.fixlink('lib' + this.libpython + '.so');

    this.airctrl = python.importSync(__dirname + '/airctrl.py');

    if (api) {
        this.api = api;
        this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
    }
}

philipsAir.prototype.decrypt = function(data, key) {}

philipsAir.prototype.configureAccessory = function(accessory) {
    this.setService(accessory);
    this.accessories.push(accessory);
}

philipsAir.prototype.didFinishLaunching = function() {
    var ips = [];
    this.config.devices.forEach(device => {
        this.addAccessory(device);
        ips.push(device.ip);
    });

    var badAccessories = [];
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

philipsAir.prototype.fetchOnce = function(accessory, endpoint) {
    var body = fetch('http://' + accessory.context.ip + endpoint).text();
    var decrypt = python.callSync(this.airctrl, 'decrypt', body, accessory.context.key);
    //this.log(decrypt);
    return decrypt;
}

philipsAir.prototype.fetchData = function(accessory, endpoint) {
    try {
        return this.fetchOnce(accessory, endpoint);
    } catch (error) {
        accessory.context.key = python.callSync(this.airctrl, 'get_key', accessory.context.ip);
        return this.fetchOnce(accessory, endpoint);
    }
}

philipsAir.prototype.setData = function(accessory, values) {
    var encrypt = python.callSync(this.airctrl, 'encrypt', JSON.stringify(values), accessory.context.key);
    var body = '';
    encrypt.forEach(element => body += String.fromCharCode(element));

    fetch('http://' + accessory.context.ip + '/di/v1/products/1/air', {
        method: 'PUT',
        body: body
    });

    /*.then(res => res.text())
    .then(body => {
        var airclient = this.airclients[ip];
        var decrypt = python.callSync(airclient, 'do_decrypt', body);
        this.log(decrypt);
        mutex.unlock();
        return decrypt;
    });*/
}

philipsAir.prototype.fetchFirmware = function(accessory) {
    if (!accessory.context.firmware || Date.now() - accessory.context.firmware.lastcheck > 1000) {
        var firmware = this.fetchData(accessory, '/di/v1/products/0/firmware');
        accessory.context.firmware = JSON.parse(firmware);
        accessory.context.firmware['lastcheck'] = Date.now();
        return accessory.context.firmware;
    } else {
        return accessory.context.firmware;
    }
}

philipsAir.prototype.updateFirmware = function(accessory) {
    var firmware = this.fetchFirmware(accessory);
    accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'Philips')
        .setCharacteristic(Characteristic.Model, firmware.name.replace('_', '/'))
        .setCharacteristic(Characteristic.SerialNumber, accessory.context.ip)
        .setCharacteristic(Characteristic.FirmwareRevision, firmware.version);
}

philipsAir.prototype.fetchFilters = function(accessory) {
    if (!accessory.context.filters || Date.now() - accessory.context.filters.lastcheck > 1000) {
        var filters = this.fetchData(accessory, '/di/v1/products/1/fltsts');
        accessory.context.filters = JSON.parse(filters);
        accessory.context.filters['lastcheck'] = Date.now();
        return accessory.context.filters;
    } else {
        return accessory.context.filters;
    }
}

philipsAir.prototype.updateFilters = function(accessory) {
    var filters = this.fetchFilters(accessory);
    accessory.getService('Pre-filter')
        .setCharacteristic(Characteristic.FilterChangeIndication, filters['fltsts0'] == 0)
        .setCharacteristic(Characteristic.FilterLifeLevel, filters['fltsts0'] / 360 * 100);
    accessory.getService('Active carbon filter')
        .setCharacteristic(Characteristic.FilterChangeIndication, filters['fltsts2'] == 0)
        .setCharacteristic(Characteristic.FilterLifeLevel, filters['fltsts2'] / 2400 * 100);
    accessory.getService('HEPA filter')
        .setCharacteristic(Characteristic.FilterChangeIndication, filters['fltsts1'] == 0)
        .setCharacteristic(Characteristic.FilterLifeLevel, filters['fltsts1'] / 4800 * 100);
}

philipsAir.prototype.fetchStatus = function(accessory) {
    if (!accessory.context.status || Date.now() - accessory.context.status.lastcheck > 1000) {
        var status = this.fetchData(accessory, '/di/v1/products/1/air');
        accessory.context.status = JSON.parse(status);
        accessory.context.status['lastcheck'] = Date.now();

        if (accessory.context.status['pwr'] == '1') {
            if (accessory.context.status['om'] == 't') {
                accessory.context.status['om'] = 100;
            } else {
                accessory.context.status['om'] = accessory.context.status['om'] * 25;
            }
        } else {
            accessory.context.status['om'] = 0;
        }

        accessory.context.status['mode'] = !(accessory.context.status['mode'] == 'M');
        accessory.context.status['iaql'] = Math.ceil(accessory.context.status['iaql'] / 3);

        return accessory.context.status;
    } else {
        return accessory.context.status;
    }
}

philipsAir.prototype.updateStatus = function(accessory) {
    accessory.context.startup = true;

    var status = this.fetchStatus(accessory);

    accessory.getService(Service.AirPurifier)
        .setCharacteristic(Characteristic.Active, status['pwr'])
        .setCharacteristic(Characteristic.TargetAirPurifierState, status['mode'])
        .setCharacteristic(Characteristic.CurrentAirPurifierState, status['pwr'] * 2)
        .setCharacteristic(Characteristic.LockPhysicalControls, status['cl'])
        .setCharacteristic(Characteristic.RotationSpeed, status['om']);

    accessory.getService(Service.AirQualitySensor)
        .setCharacteristic(Characteristic.AirQuality, status['iaql'])
        .setCharacteristic(Characteristic.PM2_5Density, status['pm25']);
}

philipsAir.prototype.setPower = function(accessory, state, callback) {
    var values = {}
    values['pwr'] = state.toString();

    this.setData(accessory, values);

    accessory.getService(Service.AirPurifier)
        .setCharacteristic(Characteristic.CurrentAirPurifierState, state * 2);

    callback();
}

philipsAir.prototype.setMode = function(accessory, state, callback) {
    var values = {}
    values['mode'] = state ? 'P' : 'M';

    this.setData(accessory, values);

    callback();
}

philipsAir.prototype.setLock = function(accessory, state, callback) {
    var values = {}
    values['cl'] = (state == 1);

    this.setData(accessory, values);

    callback();
}

philipsAir.prototype.setFan = function(accessory, state, callback) {
    var speed = Math.ceil(state / 25);
    if (speed > 0) {
        if (speed == 4) {
            speed = 't';
        }

        if (accessory.context.startup) {
            accessory.context.startup = false;
            callback();
        } else {
            var values = {}
            values['mode'] = 'M';
            values['om'] = speed.toString();
            this.setData(accessory, values);

            accessory.getService(Service.AirPurifier)
                .setCharacteristic(Characteristic.TargetAirPurifierState, 0);

            callback();
        }
    } else {
        callback();
    }
}

philipsAir.prototype.addAccessory = function(data) {
    this.log('Initializing platform accessory ' + data.name + '...');

    var accessory;
    this.accessories.forEach(cachedAccessory => {
        if (cachedAccessory.context.ip == data.ip) {
            accessory = cachedAccessory;
        }
    });

    if (!accessory) {
        var uuid = UUIDGen.generate(data.ip);
        accessory = new Accessory(data.name, uuid);

        accessory.context.ip = data.ip;

        accessory.addService(Service.AirPurifier, data.name);
        accessory.addService(Service.AirQualitySensor, data.name);
        accessory.addService(Service.FilterMaintenance, 'Pre-filter', 'Pre-filter');
        accessory.addService(Service.FilterMaintenance, 'Active carbon filter', 'Active carbon filter');
        accessory.addService(Service.FilterMaintenance, 'HEPA filter', 'HEPA filter');

        accessory.reachable = true;

        this.setService(accessory);

        this.api.registerPlatformAccessories('homebridge-philips-air', 'philipsAir', [accessory]);

        this.accessories.push(accessory);
    } else {
        accessory.context.ip = data.ip;
    }
}

philipsAir.prototype.removeAccessories = function(accessories) {
    accessories.forEach(accessory => {
        this.log(accessory.context.name + ' is removed from HomeBridge.');
        this.api.unregisterPlatformAccessories('homebridge-philips-air', 'philipsAir', [accessory]);
        this.accessories.splice(this.accessories.indexOf(accessory), 1);
    });
}

philipsAir.prototype.setService = function(accessory) {
    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.Active)
        .on('set', this.setPower.bind(this, accessory))
        .on('get', callback => {
            var status = this.fetchStatus(accessory);
            callback(null, status['pwr']);
        });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.TargetAirPurifierState)
        .on('set', this.setMode.bind(this, accessory))
        .on('get', callback => {
            var status = this.fetchStatus(accessory);
            callback(null, status['mode']);
        });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.CurrentAirPurifierState)
        .on('get', callback => {
            var status = this.fetchStatus(accessory);
            callback(null, status['pwr'] * 2);
        });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.LockPhysicalControls)
        .on('set', this.setLock.bind(this, accessory))
        .on('get', callback => {
            var status = this.fetchStatus(accessory);
            callback(null, status['cl']);
        });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.RotationSpeed)
        .on('set', this.setFan.bind(this, accessory))
        .on('get', callback => {
            var status = this.fetchStatus(accessory);
            callback(null, status['om']);
        });

    accessory.getService(Service.AirQualitySensor)
        .getCharacteristic(Characteristic.AirQuality)
        .on('get', callback => {
            var status = this.fetchStatus(accessory);
            callback(null, status['iaql']);
        });

    accessory.getService(Service.AirQualitySensor)
        .getCharacteristic(Characteristic.PM2_5Density)
        .on('get', callback => {
            var status = this.fetchStatus(accessory);
            callback(null, status['pm25']);
        });

    if (!accessory.context.key) {
        accessory.context.key = python.callSync(this.airctrl, 'get_key', accessory.context.ip);
    }

    accessory.on('identify', this.identify.bind(this, accessory));
}

philipsAir.prototype.identify = function(thisSwitch, paired, callback) {
    this.log(thisSwitch.context.name + 'identify requested!');
    callback();
}