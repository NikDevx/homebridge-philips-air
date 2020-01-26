#!/usr/bin/env python3
from Cryptodome.Cipher import AES
from Cryptodome.Util.Padding import pad, unpad
import urllib.request
import base64
import binascii
import json
import random

G = int('A4D1CBD5C3FD34126765A442EFB99905F8104DD258AC507FD6406CFF14266D31266FEA1E5C41564B777E690F5504F213160217B4B01B886A5E91547F9E2749F4D7FBD7D3B9A92EE1909D0D2263F80A76A6A24C087A091F531DBF0A0169B6A28AD662A4D18E73AFA32D779D5918D08BC8858F4DCEF97C2A24855E6EEB22B3B2E5', 16)
P = int('B10B8F96A080E01DDE92DE5EAE5D54EC52C99FBCFB06A3C69A6A9DCA52D23B616073E28675A23D189838EF1E2EE652C013ECB4AEA906112324975C3CD49B83BFACCBDD7D90C4BD7098488E9C219A73724EFFD6FAE5644738FAA31A4FF55BCCC0A151AF5F0DC8B4BD45BF37DF365C1A65E68CFDA76D4DA708DF1FB2BC2E4A4371', 16)

def aes_decrypt(data, key):
    iv = bytes(16)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    return cipher.decrypt(data)

def encrypt(values, key):
    # add two random bytes in front of the body
    data = 'AA' + json.dumps(values)
    data = pad(bytearray(data, 'ascii'), 16, style='pkcs7')
    iv = bytes(16)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    data_enc = cipher.encrypt(data)
    return base64.b64encode(data_enc)

def decrypt(data, key):
    payload = base64.b64decode(data)
    data = aes_decrypt(payload, key)
    # response starts with 2 random bytes, exclude them
    response = unpad(data, 16, style='pkcs7')[2:]
    return response.decode('ascii')

class AirClient(object):

    def __init__(self, host, hex_key):
        self._host = host
        if hex_key == None:
            self._get_key()
        else:
            self._session_key = bytes.fromhex(hex_key)

    def _get_key(self):
        #Exchanging secret key with the device ...
        url = 'http://{}/di/v1/products/0/security'.format(self._host)
        a = random.getrandbits(256)
        A = pow(G, a, P)
        data = json.dumps({'diffie': format(A, 'x')})
        data_enc = data.encode('ascii')
        req = urllib.request.Request(url=url, data=data_enc, method='PUT')
        with urllib.request.urlopen(req) as response:
            resp = response.read().decode('ascii')
            dh = json.loads(resp)
        key = dh['key']
        B = int(dh['hellman'], 16)
        s = pow(B, a, P)
        s_bytes = s.to_bytes(128, byteorder='big')[:16]
        session_key = aes_decrypt(bytes.fromhex(key), s_bytes)
        self._session_key = session_key[:16]

    def set_values(self, values):
        body = encrypt(values, self._session_key)
        url = 'http://{}/di/v1/products/1/air'.format(self._host)
        req = urllib.request.Request(url=url, data=body, method='PUT')
        try:
            with urllib.request.urlopen(req) as response:
                resp = response.read()
                resp = decrypt(resp.decode('ascii'), self._session_key)
                respKey = json.loads(resp)
                respKey['key'] = binascii.hexlify(self._session_key).decode('ascii')
                return respKey;
        except urllib.error.HTTPError as e:
            #Error setting values
            error = {}
            error['HttpRespCode'] = e.code
            return error

    def _get_once(self, url):
        with urllib.request.urlopen(url) as response:
            resp = response.read()
            resp = decrypt(resp.decode('ascii'), self._session_key)
            respKey = json.loads(resp)
            respKey['key'] = binascii.hexlify(self._session_key).decode('ascii')
            return respKey;

    def _get(self, url):
        try:
            return self._get_once(url)
        except Exception as e:
            #GET error - Will retry after getting a new key ...
            self._get_key()
            return self._get_once(url)

    def get_status(self):
        url = 'http://{}/di/v1/products/1/air'.format(self._host)
        return self._get(url)

    def get_wifi(self):
        url = 'http://{}/di/v1/products/0/wifi'.format(self._host)
        return self._get(url)

    def get_firmware(self):
        url = 'http://{}/di/v1/products/0/firmware'.format(self._host)
        return self._get(url)

    def get_filters(self):
        url = 'http://{}/di/v1/products/1/fltsts'.format(self._host)
        return self._get(url)