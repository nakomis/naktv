#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { type DeployEnv, GithubCiStack } from '../lib/github-ci-stack';

const npmEnvironment = process.env.NPM_ENVIRONMENT;
if (!npmEnvironment) {
  throw new Error('NPM_ENVIRONMENT is not set. Use `pnpm deploy-sandbox` or `pnpm deploy-prod`.');
}
if (npmEnvironment !== 'sandbox' && npmEnvironment !== 'prod') {
  throw new Error(`Unknown NPM_ENVIRONMENT "${npmEnvironment}". Must be "sandbox" or "prod".`);
}

const deployEnv = npmEnvironment as DeployEnv;
const accountId = deployEnv === 'prod' ? '637423226886' : '975050268859';

const app = new cdk.App();

new GithubCiStack(app, 'NaktvGithubCiStack', {
  env: { account: accountId, region: 'eu-west-2' },
  deployEnv,
  githubOwner: 'nakomis',
  // `gh api users/nakomis --jq .id`
  githubOwnerId: '1488244',
  githubRepo: 'naktv',
  // `gh api repos/nakomis/naktv --jq .id`
  githubRepoId: 'REPO_ID_PENDING',
  description: `GitHub Actions OIDC role for naktv CI (${deployEnv})`,
});

cdk.Tags.of(app).add('MH-Project', 'naktv');
