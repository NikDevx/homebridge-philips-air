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
};