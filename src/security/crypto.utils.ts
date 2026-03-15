import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify
} from 'node:crypto';

export function generateClaimToken() {
  return randomBytes(32).toString('base64url');
}

export function hashClaimToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyClaimToken(token: string, expectedHash: string) {
  const actual = Buffer.from(hashClaimToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyNodeSignature(
  publicKeyBase64: string,
  message: string,
  signatureBase64: string
) {
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki'
  });

  return verify(
    null,
    Buffer.from(message, 'utf8'),
    publicKey,
    Buffer.from(signatureBase64, 'base64')
  );
}
