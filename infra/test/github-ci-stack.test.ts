import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { type DeployEnv, GithubCiStack } from '../lib/github-ci-stack';

function synth(deployEnv: DeployEnv, account: string) {
  const app = new cdk.App();
  const stack = new GithubCiStack(app, 'TestStack', {
    env: { account, region: 'eu-west-2' },
    deployEnv,
    githubOwner: 'nakomis',
    githubOwnerId: '1488244',
    githubRepo: 'naktv',
    githubRepoId: '42',
  });
  return Template.fromStack(stack);
}

describe('GithubCiStack', () => {
  it.each([
    ['sandbox', '975050268859'],
    ['prod', '637423226886'],
  ] as const)('names the %s role as the tracker allow-list expects', (deployEnv, account) => {
    synth(deployEnv, account).hasResourceProperties('AWS::IAM::Role', {
      RoleName: `nakomis-naktv-github-ci-${deployEnv}`,
    });
  });

  it('trusts both forms of the GitHub OIDC subject, for this repo only', () => {
    const template = synth('sandbox', '975050268859');
    const role = Object.values(template.findResources('AWS::IAM::Role'))[0];
    const statement = role.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(statement.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(statement.Condition.StringEquals).toEqual({
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    });
    expect(statement.Condition.StringLike['token.actions.githubusercontent.com:sub']).toEqual([
      'repo:nakomis@1488244/naktv@42:*',
      'repo:nakomis/naktv:*',
    ]);
  });

  it('can assume the CDK bootstrap roles and call the deployment tracker', () => {
    const template = synth('sandbox', '975050268859');
    const policies = JSON.stringify(
      Object.values(template.findResources('AWS::IAM::Role'))[0].Properties.Policies,
    );
    expect(policies).toContain('role/cdk-hnb659fds-*');
    expect(policies).toContain('execute-api:Invoke');
    expect(policies).toContain(':637423226886:*/*/*/deployments/*');
  });

  it('exports the role ARN', () => {
    synth('prod', '637423226886').hasOutput('NaktvCiRoleArn', {});
  });
});
