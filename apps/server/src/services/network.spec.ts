import type { NetworkInterfaceInfo } from 'node:os';
import { isLoopbackUrl, pickLanUrl, type InterfaceMap } from './network';

function addr(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    family: 'IPv4',
    internal,
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: `${address}/24`,
    scopeid: -1,
  } as NetworkInterfaceInfo;
}

const interfaces: InterfaceMap = {
  lo: [addr('127.0.0.1', true)],
  docker0: [addr('172.17.0.1')],
  eth0: [addr('192.168.1.20')],
};

describe('pickLanUrl', () => {
  it('uses PUBLIC_URL verbatim', () => {
    const picked = pickLanUrl({
      publicUrl: 'http://192.168.1.99:8787',
      host: '0.0.0.0',
      port: 8787,
      interfaces,
    });
    expect(picked.url).toBe('http://192.168.1.99:8787');
  });

  it('prefers the LAN address over the docker bridge', () => {
    const picked = pickLanUrl({ host: '0.0.0.0', port: 8787, interfaces });
    expect(picked.url).toBe('http://192.168.1.20:8787');
    expect(picked.candidates).toEqual(['http://192.168.1.20:8787', 'http://172.17.0.1:8787']);
    expect(picked.confident).toBe(true);
  });

  it('reports low confidence when only a docker bridge address exists', () => {
    const picked = pickLanUrl({
      host: '0.0.0.0',
      port: 8787,
      interfaces: { docker0: [addr('172.17.0.2')] },
    });
    expect(picked.url).toBe('http://172.17.0.2:8787');
    expect(picked.confident).toBe(false);
  });
});

describe('isLoopbackUrl', () => {
  it('detects loopback hosts', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8787')).toBe(true);
    expect(isLoopbackUrl('http://localhost:8787')).toBe(true);
    expect(isLoopbackUrl('https://LOCALHOST')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8787')).toBe(true);
  });

  it('rejects LAN and public hosts', () => {
    expect(isLoopbackUrl('http://192.168.1.20:8787')).toBe(false);
    expect(isLoopbackUrl('http://127.0.0.1.example.com')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});
