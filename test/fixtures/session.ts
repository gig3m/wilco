/**
 * Shaped from the real response documented in dovetail docs/research.md.
 * The masteruser account is listed FIRST here and LAST in the work fixture,
 * because the ordering genuinely differs between sessions.
 */
export const personalSession = {
  username: "you@example.com",
  apiUrl: "https://phl.api.fastmail.com/jmap/api/",
  downloadUrl:
    "https://phl-www.fastmailusercontent.com/jmap/download/{accountId}/{blobId}/{name}?type={type}",
  uploadUrl: "https://phl.api.fastmail.com/jmap/upload/{accountId}/",
  eventSourceUrl:
    "https://phl.api.fastmail.com/jmap/event/?types={types}&closeafter={closeafter}&ping={ping}",
  capabilities: {
    "urn:ietf:params:jmap:core": { maxObjectsInGet: 4096, maxCallsInRequest: 64 },
    "urn:ietf:params:jmap:mail": {},
    "urn:ietf:params:jmap:submission": {},
  },
  accounts: {
    u99999999: {
      name: "masteruser_auto1234@fastmail.com",
      accountCapabilities: {},
    },
    u02214062: {
      name: "you@example.com",
      accountCapabilities: {
        "urn:ietf:params:jmap:mail": {},
        "urn:ietf:params:jmap:submission": {},
      },
    },
  },
  primaryAccounts: {
    "urn:ietf:params:jmap:mail": "u02214062",
    "urn:ietf:params:jmap:submission": "u02214062",
  },
};

export const workSession = {
  ...personalSession,
  username: "you@work.example",
  accounts: {
    u11111111: {
      name: "you@work.example",
      accountCapabilities: {
        "urn:ietf:params:jmap:mail": {},
        "urn:ietf:params:jmap:submission": {},
      },
    },
    u88888888: { name: "masteruser_auto5678@fastmail.com", accountCapabilities: {} },
  },
  primaryAccounts: {
    "urn:ietf:params:jmap:mail": "u11111111",
    "urn:ietf:params:jmap:submission": "u11111111",
  },
};
