# homebridge-philips-air
Homebridge Plugin for Philips Air Purifiers

Only tested on the Philips 1000i, but should work fine with any Philips connected air purifier.

### Installation
1. Install homebridge using `npm install -g homebridge`.
2. Install this plugin using `npm install -g homebridge-philips-air`.
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
| timeout_seconds    | Number of seconds to wait for a response from the purifier. (Default: 3)     | No       |
| devices            | Array of Philips air purifiers (multiple supported).                         | Yes      |
| \|- name           | Name of your device.                                                         | No       |
| \|- ip             | IP address of your device.                                                   | Yes      |
