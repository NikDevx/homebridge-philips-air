/* eslint-disable @typescript-eslint/no-explicit-any */

export type PurifierStatus = {
  om: string;
  pwr: string;
  cl: boolean;
  aqil: number;
  uil: string;
  dt: number;
  dtrs: number;
  mode: string;
  pm25: number;
  iaql: number;
  aqit: number;
  wl: number;
  rhset: number;
  rh: number;
  func: string;
  temp: number;
  ddp: string;
  err: number;
};

export type PurifierFilters = {
  fltt1: string;
  fltt2: string;
  fltsts0: number;
  fltsts1: number;
  fltsts2: number;
  wicksts: number;
};

export type PurifierFirmware = {
  name: string;
  version: string;
  upgrade: string;
  state: string;
  progress: number;
  statusmsg: string;
  mandatory: boolean;
  swversion: string;
};
