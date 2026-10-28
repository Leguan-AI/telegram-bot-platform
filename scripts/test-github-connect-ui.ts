// Unit tests for githubInstallationSettingsUrl. Pure; no database access.
// Run: npx tsx --test scripts/test-github-connect-ui.ts
import { test } from 'node:test';
import assert from 'assert';
import { githubInstallationSettingsUrl, GITHUB_INSTALLATIONS_URL } from '../lib/githubConnectUi';

test('a personal installation lives under the user’s own settings', () => {
  assert.strictEqual(
    githubInstallationSettingsUrl({ installation_id: 42, account_login: 'octocat', account_type: 'User' }),
    `${GITHUB_INSTALLATIONS_URL}/42`
  );
});

test('an organization’s installation lives under the organization’s settings', () => {
  assert.strictEqual(
    githubInstallationSettingsUrl({ installation_id: 7, account_login: 'Leguan-AI', account_type: 'Organization' }),
    'https://github.com/organizations/Leguan-AI/settings/installations/7'
  );
});

test('the organization login is URL-encoded', () => {
  assert.strictEqual(
    githubInstallationSettingsUrl({ installation_id: 1, account_login: 'a/b c', account_type: 'Organization' }),
    'https://github.com/organizations/a%2Fb%20c/settings/installations/1'
  );
});
