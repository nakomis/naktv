import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export type DeployEnv = 'sandbox' | 'prod';

/** The deployment tracker (nakomis-infra) lives in prod and serves both envs. */
export const DEPLOYMENT_TRACKER_ACCOUNT_ID = '637423226886';

export interface GithubCiStackProps extends cdk.StackProps {
  deployEnv: DeployEnv;
  githubOwner: string;
  githubOwnerId: string;
  githubRepo: string;
  githubRepoId: string;
}

/**
 * The role GitHub Actions assumes for naktv CI. NakTV itself has no AWS
 * footprint — the app is sideloaded onto the TV — so the role only needs to
 * run `cdk deploy` (via the bootstrap roles) and talk to the shared
 * deployment tracker.
 */
export class GithubCiStack extends cdk.Stack {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: GithubCiStackProps) {
    super(scope, id, props);

    const { deployEnv, githubOwner, githubOwnerId, githubRepo, githubRepoId } = props;

    const githubOidc = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidc',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    this.role = new iam.Role(this, 'NaktvCiRole', {
      roleName: `nakomis-naktv-github-ci-${deployEnv}`,
      assumedBy: new iam.WebIdentityPrincipal(githubOidc.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        // GitHub now presents the immutable-id form of the subject for new
        // repos; older ones keep the name-only form. A list is an OR.
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            `repo:${githubOwner}@${githubOwnerId}/${githubRepo}@${githubRepoId}:*`,
            `repo:${githubOwner}/${githubRepo}:*`,
          ],
        },
      }),
      description: `Assumed by naktv GitHub Actions CI (${deployEnv})`,
      inlinePolicies: {
        CdkDeploy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['sts:AssumeRole'],
              resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
            }),
          ],
        }),
        // The tracker's resource policy allow-lists this role, which is enough
        // for a same-account caller. The sandbox role calls cross-account, so
        // it needs an identity policy as well; granting it in both is harmless.
        DeploymentTracker: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['execute-api:Invoke'],
              resources: [
                `arn:aws:execute-api:${this.region}:${DEPLOYMENT_TRACKER_ACCOUNT_ID}:*/*/*/deployments/*`,
              ],
            }),
          ],
        }),
      },
    });

    new cdk.CfnOutput(this, 'NaktvCiRoleArn', {
      value: this.role.roleArn,
      description: `IAM role for naktv GitHub Actions CI (${deployEnv})`,
    });
  }
}
