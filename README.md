# homebridge-philips-air
[![npm](https://img.shields.io/npm/v/homebridge-philips-air) ![npm](https://img.shields.io/npm/dt/homebridge-philips-air)](https://www.npmjs.com/package/homebridge-philips-air)

Homebridge Plugin for Philips Air Purifiers

This plugin is now using [py-air-control](https://github.com/rgerganov/py-air-control) directly to enable support for newer Philips connected air purifier models.

### Installation
1. Install Homebridge using the [official instructions](https://github.com/homebridge/homebridge/wiki).
2. Install this plugin using `npm install -g homebridge-philips-air --unsafe-perm`.
3. Update your configuration file. See configuration sample below.

If you have issues with the postinstall script from philips-air, you can follow the [manual post install steps](https://github.com/Sunoo/philips-air#manual-post-install-steps) for that package.

### Configuration
Edit your `config.json` accordingly. Configuration sample:
```
    "platforms": [{
        "platform": "philipsAir",
        "devices": [{
            "name": "Living Room Purifier",
            "ip": "10.0.1.16",
            "protocol": "http"
        }]
    }]
```

| Fields             | Description                                                                  | Required |
|--------------------|------------------------------------------------------------------------------|----------|
| platform           | Must always be `philipsAir`.                                                 | Yes      |
| name               | For logging purposes.                                                        | No       |
| timeout_seconds    | Number of seconds to wait for a response from the purifier. (Default: 5)     | No       |
| devices            | Array of Philips air purifiers (multiple supported).                         | Yes      |
| \|- name           | Name of your device.                                                         | No       |
| \|- ip             | IP address of your device.                                                   | Yes      |
| \|- protocol       | Protocol used by your device: http (default), plain\_coap, coap              | No       |
| \|- sleep\_speed   | Does this device support 'sleep' speed?                                      | No       |
| \|- light\_control | Expose device lights as lightbulbs.                                          | No       |
