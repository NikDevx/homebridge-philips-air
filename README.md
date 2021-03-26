# homebridge-philips-air

[![npm](https://img.shields.io/npm/v/homebridge-philips-air) ![npm](https://img.shields.io/npm/dt/homebridge-philips-air)](https://www.npmjs.com/package/homebridge-philips-air) [![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

Homeridge Plugin for Philips Air Purifiers

This plugin is now using [py-air-control](https://github.com/rgerganov/py-air-control) directly to enable support for newer Philips connected air purifier models.

## Installation

1. Install Homebridge using the [official instructions](https://github.com/homebridge/homebridge/wiki).
2. Install this plugin using `sudo npm install -g homebridge-philips-air --unsafe-perm`.
3. Update your configuration file. See configuration sample below.

If you are using CoAP or Plain CoAP:

1. Install pip and git using `sudo apt install python3-pip git`.
2. Install py-air-control using `sudo pip3 install py-air-control`.
3. Update CoAPthon3 using `sudo pip3 install -U git+https://github.com/Tanganelli/CoAPthon3@89d5173`.

Plain CoAP users only will also need to do:

1. Allow non-root to send pings using `echo "net.ipv4.ping_group_range=0 1000" | sudo tee -a /etc/sysctl.conf`.
2. Update running sysctl configuration using `sudo sysctl -p`.

If you're only using HTTP, no additional steps are required.

### Configuration

Edit your `config.json` accordingly. Configuration sample:

```json
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
|- name           | Name of your device.                                                         | No       |
|- ip             | IP address of your device.                                                   | Yes      |
|- protocol       | Protocol used by your device: http (default), plain\_coap, coap              | No       |
|- sleep\_speed   | Does this device support 'sleep' speed?                                      | No       |
|- light\_control | Expose device lights as lightbulbs.                                          | No       |
|- allergic\_func | Does this device support 'allergic' function?                                           | No       |
|- water\_level | Expose device water level as water leak sensor.                                            | No       |
|- temperature\_sensor | Expose device temperature as temperature sensor.                                     | No       |
|- humidity\_sensor | Expose device humidity as humidity sensor.                                          | No       |
|- polling | Adding a refresh time for the all sensors refresh in seconds.                                          | No       |
|- humidifier | Adding humidified support.                                          | No       |
|- logger | Getting data from humidity and temp sensors and save value into txt file.                                          | No       |

