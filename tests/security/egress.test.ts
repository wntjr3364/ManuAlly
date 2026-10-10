// PW-059 security audit — egress negative tests for the one general URL fetch the server has (open-access
// PDFs, PW-034), spec 09 "외부 fetch는 scheme/host/port·redirect·DNS resolved IP 재검사":
// TST-059A: no scheme but https, no port but 443, no credentials in the URL, no IP literal, no host off the
//   list (look-alikes included); every resolved address checked — loopback, private, link-local, cloud
//   metadata, CGNAT, multicast and IPv4 hidden in IPv6 refused — and one bad address among good ones refuses
//   the fetch before any connection.
import { describe, expect, test } from 'vitest';
import { checkFetchUrl, FetchRefused, isInternalAddress } from '../../packages/domain/src/asset-policy/index.ts';
import { fetchSourcePdf } from '../../apps/api/src/assets/fetch.ts';

const reason = (fn: () => unknown) => { try { fn(); return 'accepted'; } catch (e) { return e instanceof FetchRefused ? e.reason : 'other'; } };

describe('TST-059A: URLs a fetch refuses', () => {
  test.each([
    ['http://europepmc.org/a.pdf', 'bad_url'], ['file:///etc/passwd', 'bad_url'], ['gopher://europepmc.org/', 'bad_url'], ['ftp://europepmc.org/a.pdf', 'bad_url'],
    ['javascript:alert(1)', 'bad_url'], ['data:application/pdf;base64,AAAA', 'bad_url'], ['https://user:pw@europepmc.org/a.pdf', 'bad_url'],
    ['https://europepmc.org:8443/a.pdf', 'bad_url'], ['https://127.0.0.1/a.pdf', 'host_not_allowed'], ['https://[::1]/a.pdf', 'host_not_allowed'],
    ['https://169.254.169.254/latest/meta-data/', 'host_not_allowed'], ['https://localhost/a.pdf', 'host_not_allowed'], ['https://metadata.google.internal/', 'host_not_allowed'],
    ['https://europepmc.org.evil.example/a.pdf', 'host_not_allowed'], ['https://evil.example/europepmc.org/a.pdf', 'host_not_allowed'], ['https://europepmc.org@evil.example/', 'bad_url'],
    ['https://xn--europepmc-xyz.org/', 'host_not_allowed'], ['not a url', 'bad_url'], [`https://europepmc.org/${'a'.repeat(2100)}`, 'bad_url'],
  ])('%s → %s', (url, want) => {
    expect(reason(() => checkFetchUrl(url))).toBe(want);
  });
  test('an IP literal is refused even if someone puts it on the host list', () => {
    expect(reason(() => checkFetchUrl('https://127.0.0.1/a.pdf', ['127.0.0.1']))).toBe('host_not_allowed');
    expect(reason(() => checkFetchUrl('https://[::1]/a.pdf', ['[::1]', '::1']))).toBe('host_not_allowed');
    expect(() => checkFetchUrl('https://127.0.0.1/a.pdf', ['127.0.0.1'])).toThrow(/IP addresses/);
  });
  test('the listed hosts pass, with a trailing dot or capitals too', () => {
    for (const u of ['https://europepmc.org/a.pdf', 'https://EUROPEPMC.ORG/a.pdf', 'https://arxiv.org./pdf/1', 'https://europepmc.org:443/a.pdf']) expect(reason(() => checkFetchUrl(u)), u).toBe('accepted');
  });
});

describe('TST-059A: resolved addresses a fetch refuses', () => {
  test.each([
    '127.0.0.1', '127.255.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.254',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '::', '::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:0:127.0.0.1', '64:ff9b::127.0.0.1', '64:ff9b::a9fe:a9fe', '::127.0.0.1', '2002:7f00:1::1',
    '0177.0.0.1', '2130706433', 'not-an-ip',
  ])('%s is internal (or not an address)', (a) => {
    expect(isInternalAddress(a)).toBe(true);
  });
  test('public addresses are not', () => {
    for (const a of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:93.184.216.34']) expect(isInternalAddress(a), a).toBe(false);
  });
  test('one internal address among public ones refuses the fetch before any connection (DNS rebinding)', async () => {
    let tries = 0;
    const url = checkFetchUrl('https://europepmc.org/a.pdf');
    for (const addrs of [['93.184.216.34', '127.0.0.1'], ['169.254.169.254'], ['::ffff:10.0.0.1', '2606:4700:4700::1111']]) {
      await expect(fetchSourcePdf({ resolve: async () => { tries++; return addrs; }, timeoutMs: 1000 }, url, 1024)).rejects.toMatchObject({ reason: 'internal_address' });
    }
    expect(tries).toBe(3);
    await expect(fetchSourcePdf({ resolve: async () => [] }, url, 1024)).rejects.toMatchObject({ reason: 'network' });
    await expect(fetchSourcePdf({ resolve: async () => { throw new Error('nxdomain'); } }, url, 1024)).rejects.toMatchObject({ reason: 'network' });
  });
});
