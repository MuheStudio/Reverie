'use strict';

const SCHEMES = Object.freeze([
  {
    scheme: 'reverie-avatar',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
  {
    scheme: 'reverie-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
      bypassCSP: false,
    },
  },
  {
    scheme: 'reverie-focus',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
  {
    scheme: 'reverie-sticker',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
  {
    scheme: 'reverie-video',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
  {
    scheme: 'reverie-live2d-core',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
      bypassCSP: false,
    },
  },
]);

function registerDesktopSchemes(protocol) {
  protocol.registerSchemesAsPrivileged(SCHEMES);
}

module.exports = {
  SCHEMES,
  registerDesktopSchemes,
};
