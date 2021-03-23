export type PhilipsAirPlatformConfig = {
    name: string;
    timeout_seconds: number;
    devices: Array<DeviceConfig>
};

export type DeviceConfig = {
    name: string;
    ip: string;
    protocol: string;
    sleep_speed: boolean;
    light_control: boolean;
    allergic_func: boolean;
    water_level: boolean;
    temperature_sensor: boolean;
    polling_interval_temperature_sensor: number;
    humidity_sensor: boolean;
    polling_interval_humidity_sensor: number;
    humidifier: boolean
};