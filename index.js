const python = require("node-calls-python").interpreter;
var Accessory, Service, Characteristic, UUIDGen;

module.exports = function(homebridge) {
    Accessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;

    homebridge.registerPlatform("homebridge-philips-air", "philipsAir", philipsAir, true);
}

function philipsAir(log, config, api) {
    this.log = log;
    this.config = config;

    this.libpython = config.libpython || 'python3.7m';

    this.accessories = [];
    this.airclients = {};
    this.timeouts = {};

    python.fixlink('lib' + this.libpython + '.so');

    this.airctrl = python.importSync(__dirname + '/airctrl.py');

    if (api) {
        this.api = api;
        this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
    }
}

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

    this.accessories.forEach(accessory => this.updateStatus(accessory));
}

philipsAir.prototype.fetchStatus = function(accessory) {
    if (!accessory.context.status || Date.now() - accessory.context.status.lastcheck > 1000) {
        var airclient = this.airclients[accessory.context.ip];
        var status = python.callSync(airclient, 'get_status');

        if (status['pwr'] == '1') {
            if (status['om'] == 't') {
                status['om'] = 100;
            } else {
                status['om'] = status['om'] * 25;
            }
        } else {
            status['om'] = 0;
        }

        status['mode'] = !(status['mode'] == 'M');

        status['iaql'] = Math.ceil(status['iaql'] / 3);

        if (status['key']) {
            accessory.context.key = status['key'];
        }

        status['lastcheck'] = Date.now();

        accessory.context.status = status;

        return status;
    } else {
        return accessory.context.status;
    }
}

philipsAir.prototype.updateStatus = function(accessory) {
    var status = this.fetchStatus(accessory);

    accessory.context.startup = true;

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
    var airclient = this.airclients[accessory.context.ip];

    var values = {}
    values['pwr'] = state.toString();
    var status = python.callSync(airclient, 'set_values', values);

    accessory.getService(Service.AirPurifier)
        .setCharacteristic(Characteristic.CurrentAirPurifierState, state * 2);

    if (status['key']) {
        accessory.context.key = status['key'];
    }

    callback();
}

philipsAir.prototype.setMode = function(accessory, state, callback) {
    var airclient = this.airclients[accessory.context.ip];

    var values = {}
    values['mode'] = state ? 'P' : 'M';
    var status = python.callSync(airclient, 'set_values', values);

    if (status['key']) {
        accessory.context.key = status['key'];
    }

    callback();
}

philipsAir.prototype.setLock = function(accessory, state, callback) {
    var airclient = this.airclients[accessory.context.ip];

    var values = {}
    values['cl'] = (state == 1);
    var status = python.callSync(airclient, 'set_values', values);

    if (status['key']) {
        accessory.context.key = status['key'];
    }

    callback();
}

philipsAir.prototype.setFan = function(accessory, state, callback) {
    var airclient = this.airclients[accessory.context.ip];

    var speed = Math.ceil(state / 25);
    if (speed > 0) {
        if (speed == 4) {
            speed = 't';
        }

        if (accessory.context.startup) {
            accessory.context.startup = false;
        } else {
            var values = {}
            values['mode'] = 'M';
            values['om'] = speed.toString();
            var status = python.callSync(airclient, 'set_values', values);

            accessory.getService(Service.AirPurifier)
                .setCharacteristic(Characteristic.TargetAirPurifierState, 0);

            if (status['key']) {
                accessory.context.key = status['key'];
            }
        }
    }

    callback();
}

philipsAir.prototype.addAccessory = function(data) {
    this.log("Initializing platform accessory '" + data.name + "'...");

    var accessory;
    this.accessories.forEach(cachedAccessory => {
        if (cachedAccessory.context.ip == data.ip) {
            accessory = cachedAccessory;
        }
    });

    if (!accessory) {
        var uuid = UUIDGen.generate(data.ip);
        accessory = new Accessory(data.name, uuid);

        accessory.context = data;

        accessory.addService(Service.AirPurifier, data.name);
        accessory.addService(Service.AirQualitySensor, data.name);
        accessory.addService(Service.FilterMaintenance, "Pre-filter", "Pre-filter");
        accessory.addService(Service.FilterMaintenance, "Active carbon filter", "Active carbon filter");
        accessory.addService(Service.FilterMaintenance, "HEPA filter", "HEPA filter");

        accessory.reachable = true;

        this.setService(accessory);

        this.api.registerPlatformAccessories("homebridge-philips-air", "philipsAir", [accessory]);

        this.accessories.push(accessory);
    } else {
        accessory.context = data;
    }

    this.getInitState(accessory);
}

philipsAir.prototype.removeAccessories = function(accessories) {
    accessories.forEach(accessory => {
        this.log(accessory.context.name + " is removed from HomeBridge.");
        this.api.unregisterPlatformAccessories("homebridge-philips-air", "philipsAir", [accessory]);
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

    this.airclients[accessory.context.ip] = python.createSync(this.airctrl, 'AirClient', accessory.context.ip, accessory.context.key);

    accessory.on('identify', this.identify.bind(this, accessory));
}

philipsAir.prototype.getInitState = function(accessory) {
    accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, "Philips")
        .setCharacteristic(Characteristic.Model, "Air Purifier")
        .setCharacteristic(Characteristic.SerialNumber, accessory.context.ip);

    accessory.updateReachability(true);
}

philipsAir.prototype.identify = function(thisSwitch, paired, callback) {
    this.log(thisSwitch.context.name + "identify requested!");
    callback();
}