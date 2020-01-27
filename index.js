const crypto = require('crypto');
const fetch = require('sync-fetch');
const aesjs = require('aes-js');
const pkcs7 = require('pkcs7-padding')
var Accessory, Service, Characteristic, UUIDGen;

G = 'A4D1CBD5C3FD34126765A442EFB99905F8104DD258AC507FD6406CFF14266D31266FEA1E5C41564B777E690F5504F213160217B4B01B886A5E91547F9E2749F4D7FBD7D3B9A92EE1909D0D2263F80A76A6A24C087A091F531DBF0A0169B6A28AD662A4D18E73AFA32D779D5918D08BC8858F4DCEF97C2A24855E6EEB22B3B2E5';
P = 'B10B8F96A080E01DDE92DE5EAE5D54EC52C99FBCFB06A3C69A6A9DCA52D23B616073E28675A23D189838EF1E2EE652C013ECB4AEA906112324975C3CD49B83BFACCBDD7D90C4BD7098488E9C219A73724EFFD6FAE5644738FAA31A4FF55BCCC0A151AF5F0DC8B4BD45BF37DF365C1A65E68CFDA76D4DA708DF1FB2BC2E4A4371';

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

    if (this.config.timeout_seconds) {
        this.timeout = this.config.timeout_seconds * 1000;
    } else {
        this.timeout = 3000;
    }

    this.accessories = [];

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

    this.accessories.forEach(accessory => {
        this.updateFirmware(accessory);
        this.updateStatus(accessory);
        this.updateFilters(accessory);
    });
}

philipsAir.prototype.bytesToString = function(array) {
    var decode = '';
    array.forEach(element => decode += String.fromCharCode(element));
    return decode;
}

philipsAir.prototype.aesDecrypt = function(data, key) {
    var iv = Buffer.from("00000000000000000000000000000000", 'hex');
    var crypto = new aesjs.ModeOfOperation.cbc(key, iv);
    return crypto.decrypt(Buffer.from(data, 'hex'));
}

philipsAir.prototype.decrypt = function(data, key) {
    var payload = Buffer.from(data, 'base64');
    var decrypt = this.bytesToString(this.aesDecrypt(payload, key).slice(2));
    return decrypt.substring(0, decrypt.lastIndexOf('}') + 1);
}

philipsAir.prototype.encrypt = function(data, key) {
    data = pkcs7.pad('AA' + data);
    var iv = Buffer.from("00000000000000000000000000000000", 'hex');
    var crypto = new aesjs.ModeOfOperation.cbc(key, iv);
    var encrypt = crypto.encrypt(Buffer.from(data, 'ascii'));
    return Buffer.from(encrypt).toString('base64');
}

philipsAir.prototype.getKey = function(accessory) {
    if (!accessory.context.lastkey || Date.now() - accessory.context.lastkey > 30 * 1000) {
        accessory.context.lastkey = Date.now();
        try {
            var a = crypto.createDiffieHellman(P, 'hex', G, 'hex');
            a.generateKeys();
            var data = {
                'diffie': a.getPublicKey('hex')
            };
            var dh = fetch('http://' + accessory.context.ip + '/di/v1/products/0/security', {
                method: 'PUT',
                body: JSON.stringify(data),
                timeout: this.timeout
            }).json();
            var s = a.computeSecret(dh['hellman'], 'hex', 'hex');
            var s_bytes = Buffer.from(s, 'hex').slice(0, 16);
            accessory.context.key = this.aesDecrypt(dh['key'], s_bytes).slice(0, 16);
        } catch (err) {
            this.log("Unable to load key: " + err);
        }
    }
}

philipsAir.prototype.fetchOnce = function(accessory, endpoint) {
    var body = fetch('http://' + accessory.context.ip + endpoint, {
        timeout: this.timeout
    }).text();
    return this.decrypt(body, accessory.context.key);
}

philipsAir.prototype.fetchData = function(accessory, endpoint) {
    try {
        return this.fetchOnce(accessory, endpoint);
    } catch (err) {
        this.getKey(accessory);
        return this.fetchOnce(accessory, endpoint);
    }
}

philipsAir.prototype.setData = function(accessory, values) {
    var encrypt = this.encrypt(JSON.stringify(values), accessory.context.key);

    fetch('http://' + accessory.context.ip + '/di/v1/products/1/air', {
        method: 'PUT',
        body: encrypt,
        timeout: this.timeout
    });
}

philipsAir.prototype.fetchFirmware = function(accessory) {
    if (!accessory.context.lastfirmware || Date.now() - accessory.context.lastfirmware > 1000) {
        accessory.context.lastfirmware = Date.now();
        var firmware = this.fetchData(accessory, '/di/v1/products/0/firmware');
        accessory.context.firmware = JSON.parse(firmware);

        accessory.context.firmware.name = accessory.context.firmware.name.replace('_', '/');
    }

    return accessory.context.firmware;
}

philipsAir.prototype.updateFirmware = function(accessory) {
    var accInfo = accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'Philips')
        .setCharacteristic(Characteristic.SerialNumber, accessory.context.ip);

    try {
        var firmware = this.fetchFirmware(accessory);
        accInfo.setCharacteristic(Characteristic.Model, firmware.name)
            .setCharacteristic(Characteristic.FirmwareRevision, firmware.version);
    } catch (err) {
        this.log("Unable to load firmware info: " + err);
    }
}

philipsAir.prototype.fetchFilters = function(accessory) {
    if (!accessory.context.lastfilters || Date.now() - accessory.context.lastfilters > 1000) {
        accessory.context.lastfilters = Date.now();
        var filters = this.fetchData(accessory, '/di/v1/products/1/fltsts');
        accessory.context.filters = JSON.parse(filters);

        accessory.context.filters.fltsts0change = accessory.context.filters.fltsts0 == 0;
        accessory.context.filters.fltsts0life = accessory.context.filters.fltsts0 / 360 * 100;
        accessory.context.filters.fltsts2change = accessory.context.filters.fltsts0 == 0;
        accessory.context.filters.fltsts2life = accessory.context.filters.fltsts0 / 2400 * 100;
        accessory.context.filters.fltsts1change = accessory.context.filters.fltsts0 == 0;
        accessory.context.filters.fltsts1life = accessory.context.filters.fltsts0 / 4800 * 100;
    }

    return accessory.context.filters;
}

philipsAir.prototype.updateFilters = function(accessory) {
    try {
        var filters = this.fetchFilters(accessory);
        accessory.getService('Pre-filter')
            .setCharacteristic(Characteristic.FilterChangeIndication, filters.fltsts0change)
            .setCharacteristic(Characteristic.FilterLifeLevel, filters.fltsts0life);
        accessory.getService('Active carbon filter')
            .setCharacteristic(Characteristic.FilterChangeIndication, filters.fltsts2change)
            .setCharacteristic(Characteristic.FilterLifeLevel, filters.fltsts2life);
        accessory.getService('HEPA filter')
            .setCharacteristic(Characteristic.FilterChangeIndication, filters.fltsts1change)
            .setCharacteristic(Characteristic.FilterLifeLevel, filters.fltsts1life);
    } catch (err) {
        this.log("Unable to load filter info: " + err);
    }
}

philipsAir.prototype.fetchStatus = function(accessory) {
    if (!accessory.context.laststatus || Date.now() - accessory.context.laststatus > 1000) {
        accessory.context.laststatus = Date.now();
        var status = this.fetchData(accessory, '/di/v1/products/1/air');
        accessory.context.status = JSON.parse(status);

        accessory.context.status.mode = !(accessory.context.status.mode == 'M');
        accessory.context.status.iaql = Math.ceil(accessory.context.status.iaql / 3);
        accessory.context.status.status = accessory.context.status.pwr * 2;

        if (accessory.context.status.pwr == '1' && accessory.context.status.mode != 0) {
            if (accessory.context.status.om == 't') {
                accessory.context.status.om = 100;
            } else {
                accessory.context.status.om = accessory.context.status.om * 25;
            }
        } else {
            accessory.context.status.om = 0;
        }
    }

    return accessory.context.status;
}

philipsAir.prototype.updateStatus = function(accessory) {
    try {
        accessory.context.startup = true;

        var status = this.fetchStatus(accessory);

        accessory.getService(Service.AirPurifier)
            .setCharacteristic(Characteristic.Active, status.pwr)
            .setCharacteristic(Characteristic.TargetAirPurifierState, status.mode)
            .setCharacteristic(Characteristic.CurrentAirPurifierState, status.status)
            .setCharacteristic(Characteristic.LockPhysicalControls, status.cl)
            .setCharacteristic(Characteristic.RotationSpeed, status.om);

        accessory.getService(Service.AirQualitySensor)
            .setCharacteristic(Characteristic.AirQuality, status.iaql)
            .setCharacteristic(Characteristic.PM2_5Density, status.pm25);
    } catch (err) {
        this.log("Unable to load status info: " + err);
        accessory.context.startup = false;
    }
}

philipsAir.prototype.setPower = function(accessory, state, callback) {
    try {
        var values = {}
        values['pwr'] = state.toString();

        this.setData(accessory, values);

        accessory.getService(Service.AirPurifier)
            .setCharacteristic(Characteristic.CurrentAirPurifierState, state * 2);

        callback();
    } catch (err) {
        callback(err);
    }
}

philipsAir.prototype.setMode = function(accessory, state, callback) {
    try {
        var values = {}
        values.mode = state ? 'P' : 'M';

        if (state != 0) {
            accessory.getService(Service.AirPurifier)
                .updateCharacteristic(Characteristic.RotationSpeed, 0);
        }

        this.setData(accessory, values);

        callback();
    } catch (err) {
        callback(err);
    }
}

philipsAir.prototype.setLock = function(accessory, state, callback) {
    try {
        var values = {}
        values.cl = (state == 1);

        this.setData(accessory, values);

        callback();
    } catch (err) {
        callback(err);
    }
}

philipsAir.prototype.setFan = function(accessory, state, callback) {
    try {
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
                values.mode = 'M';
                values.om = speed.toString();
                this.setData(accessory, values);

                accessory.getService(Service.AirPurifier)
                    .updateCharacteristic(Characteristic.TargetAirPurifierState, 0);

                callback();
            }
        } else {
            callback();
        }
    } catch (err) {
        callback(err);
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

        accessory.context.name = data.name;
        accessory.context.ip = data.ip;

        accessory.addService(Service.AirPurifier, data.name);
        accessory.addService(Service.AirQualitySensor, data.name);
        accessory.addService(Service.FilterMaintenance, 'Pre-filter', 'Pre-filter');
        accessory.addService(Service.FilterMaintenance, 'Active carbon filter', 'Active carbon filter');
        accessory.addService(Service.FilterMaintenance, 'HEPA filter', 'HEPA filter');

        this.setService(accessory);

        this.api.registerPlatformAccessories('homebridge-philips-air', 'philipsAir', [accessory]);

        this.accessories.push(accessory);
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
    if (!accessory.context.key) {
        this.getKey(accessory);
    }

    accessory.on('identify', (paired, callback) => {
        this.log(accessory.context.name + ' identify requested!');
        callback();
    });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.Active)
        .on('set', this.setPower.bind(this, accessory))
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.pwr);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.TargetAirPurifierState)
        .on('set', this.setMode.bind(this, accessory))
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.mode);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.CurrentAirPurifierState)
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.status);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.LockPhysicalControls)
        .on('set', this.setLock.bind(this, accessory))
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.cl);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.RotationSpeed)
        .on('set', this.setFan.bind(this, accessory))
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.om);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService(Service.AirQualitySensor)
        .getCharacteristic(Characteristic.AirQuality)
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.iaql);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService(Service.AirQualitySensor)
        .getCharacteristic(Characteristic.PM2_5Density)
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.pm25);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService('Pre-filter')
        .getCharacteristic(Characteristic.FilterChangeIndication)
        .on('get', callback => {
            try {
                var filters = this.fetchFilters(accessory);
                callback(null, filters.fltsts0change);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService('Pre-filter')
        .getCharacteristic(Characteristic.FilterLifeLevel)
        .on('get', callback => {
            try {
                var filters = this.fetchFilters(accessory);
                callback(null, filters.fltsts0life);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService('Active carbon filter')
        .getCharacteristic(Characteristic.FilterChangeIndication)
        .on('get', callback => {
            try {
                var filters = this.fetchFilters(accessory);
                callback(null, filters.fltsts2change);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService('Active carbon filter')
        .getCharacteristic(Characteristic.FilterLifeLevel)
        .on('get', callback => {
            try {
                var filters = this.fetchFilters(accessory);
                callback(null, filters.fltsts2life);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService('HEPA filter')
        .getCharacteristic(Characteristic.FilterChangeIndication)
        .on('get', callback => {
            try {
                var filters = this.fetchFilters(accessory);
                callback(null, filters.fltsts1change);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService('HEPA filter')
        .getCharacteristic(Characteristic.FilterLifeLevel)
        .on('get', callback => {
            try {
                var filters = this.fetchFilters(accessory);
                callback(null, filters.fltsts1life);
            } catch (err) {
                callback(err);
            }
        });
}