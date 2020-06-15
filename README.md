# homebridge-philips-air-httponly
Homebridge Plugin for Philips Air Purifiers

This will only work on pre-2020 models, for newer models you will need to use [homebridge-philips-air](https://github.com/Sunoo/homebridge-philips-air). If you are switching from that version, please make sure you uninstall it when you install this, or you will likely encounter problems.

### Installation
1. Install homebridge using `npm install -g homebridge`.
2. Install this plugin using `npm install -g homebridge-philips-air-httponly`.
3. Update your configuration file. See configuration sample below.

### Configuration
Edit your `config.json` accordingly. Configuration sample:
```
    "platforms": [{
        "platform": "philipsAir",
        "devices": [{
            "name": "Living Room Purifier",
            "ip": "10.0.1.16"
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
| \|- sleep\_speed   | Does this device support 'sleep' speed?                                      | No       |
| \|- light\_control | Expose device lights as lightbulbs.                                          | No       |
