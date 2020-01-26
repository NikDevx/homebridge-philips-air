# homebridge-philips-air-purifier
Homebridge Plugin for Philips Air Purifiers

Only tested on the Philips 1000i, but should work fine with any Philips connected air purifier.

### Installation
1. Install pip using `sudo apt install python3-pip`.
2. Install pycryptodomex using `sudo pip3 install pycryptodomex`.
3. Install homebridge using `npm install -g homebridge`.
4. Install this plugin using `npm install -g homebridge-philips-air-purifier --unsafe-perm`.
5. Update your configuration file. See configuration sample below.

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
| libpython          | **See note below.**                                                          | No       |
| devices            | Array of Philips air purifiers (multiple supported).                         | Yes      |
| \|- name           | Name of your device.                                                         | No       |
| \|- ip             | IP address of your device.                                                   | Yes      |

### libpython Setting
If you are running a version of Python other than 3.7, you may need to update this value. You probably won't want to touch this unless you encounter problems. Here is how to find that value.
1. Run `python3-config --libs`.
2. You'll see something like `-lpython3.7m -lcrypt -lpthread -ldl  -lutil -lm`.
3. You want the first item listed, excluding the -l. In this example, it would be `python3.7m`.