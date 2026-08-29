import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluator.js';

describe('evaluate policy origin attribution', () => {
  const resource = {
    arn: 'arn:aws:s3:::my-bucket',
    accountId: '123456789012',
  };

  it('attributes explicit deny from a group policy', () => {
    const user = {
      accountId: '123456789012',
      policies: [
        {
          PolicyName: 'SalesDenyWrite',
          Statement: [
            {
              Sid: 'DenySalesBucket',
              Effect: 'Deny',
              Action: 's3:PutObject',
              Resource: 'arn:aws:s3:::my-bucket/*',
            },
          ],
          origin: {
            sourceType: 'group',
            groupName: 'Developers',
            policyName: 'SalesDenyWrite',
            policyArn: 'arn:aws:iam::123456789012:policy/SalesDenyWrite',
          },
        },
      ],
    };

    const result = evaluate(resource, 's3:PutObject', user);
    expect(result.allowed).toBe(false);
    expect(result.origin).toEqual({
      sourceType: 'group',
      groupName: 'Developers',
      policyName: 'SalesDenyWrite',
      policyArn: 'arn:aws:iam::123456789012:policy/SalesDenyWrite',
      sid: 'DenySalesBucket',
    });
    expect(result.reason).toContain('Explicit Deny in group "Developers" policy "SalesDenyWrite"');
    expect(result.reason).toContain('Sid: DenySalesBucket');
  });

  it('attributes explicit deny from a direct user identity policy', () => {
    const user = {
      accountId: '123456789012',
      policies: [
        {
          PolicyName: 'UserInlinePolicy',
          Statement: [
            {
              Sid: 'DenyDelete',
              Effect: 'Deny',
              Action: 's3:DeleteObject',
            },
          ],
          origin: {
            sourceType: 'identity',
            policyName: 'UserInlinePolicy',
          },
        },
      ],
    };

    const result = evaluate(resource, 's3:DeleteObject', user);
    expect(result.allowed).toBe(false);
    expect(result.origin).toEqual({
      sourceType: 'identity',
      policyName: 'UserInlinePolicy',
      sid: 'DenyDelete',
    });
    expect(result.reason).toContain('Explicit Deny in user identity policy "UserInlinePolicy" (Sid: DenyDelete)');
  });

  it('attributes explicit deny from an SSO permission set', () => {
    const user = {
      accountId: '123456789012',
      policies: [
        {
          PolicyName: 'DevPermissions',
          Statement: [
            {
              Sid: 'DenyPut',
              Effect: 'Deny',
              Action: 's3:PutObject',
            },
          ],
          origin: {
            sourceType: 'role',
            permissionSetName: 'Dev',
            policyName: 'DevPermissions',
          },
        },
      ],
    };

    const result = evaluate(resource, 's3:PutObject', user);
    expect(result.allowed).toBe(false);
    expect(result.origin).toEqual({
      sourceType: 'role',
      permissionSetName: 'Dev',
      policyName: 'DevPermissions',
      sid: 'DenyPut',
    });
    expect(result.reason).toContain('Explicit Deny in SSO role/permission set "Dev" policy "DevPermissions"');
  });

  it('attributes explicit deny from an SSO group permission set', () => {
    const user = {
      accountId: '123456789012',
      policies: [
        {
          PolicyName: 'DevPermissions',
          Statement: [
            {
              Sid: 'DenyPut',
              Effect: 'Deny',
              Action: 's3:PutObject',
            },
          ],
          origin: {
            sourceType: 'group',
            groupName: 'PlatformEngineers',
            permissionSetName: 'Dev',
            policyName: 'DevPermissions',
          },
        },
      ],
    };

    const result = evaluate(resource, 's3:PutObject', user);
    expect(result.allowed).toBe(false);
    expect(result.origin).toEqual({
      sourceType: 'group',
      groupName: 'PlatformEngineers',
      permissionSetName: 'Dev',
      policyName: 'DevPermissions',
      sid: 'DenyPut',
    });
    expect(result.reason).toContain('Explicit Deny in SSO group "PlatformEngineers" (Permission Set: "Dev", Policy: "DevPermissions", Sid: DenyPut)');
  });

  it('attributes explicit deny from a resource policy', () => {
    const bucketWithPolicy = {
      arn: 'arn:aws:s3:::my-bucket',
      accountId: '123456789012',
      policy: JSON.stringify({
        Statement: [
          {
            Sid: 'DenyAllExternal',
            Effect: 'Deny',
            Principal: '*',
            Action: 's3:GetObject',
          },
        ],
      }),
    };

    const user = {
      accountId: '123456789012',
      policies: [
        {
          Statement: [{ Effect: 'Allow', Action: 's3:GetObject' }],
        },
      ],
    };

    const result = evaluate(bucketWithPolicy, 's3:GetObject', user);
    expect(result.allowed).toBe(false);
    expect(result.origin).toEqual({
      sourceType: 'resource',
      sid: 'DenyAllExternal',
    });
    expect(result.reason).toContain('Explicit Deny in resource policy (Sid: DenyAllExternal)');
  });

  it('provides descriptive reason when no allow matches', () => {
    const user = {
      accountId: '123456789012',
      policies: [],
    };

    const result = evaluate(resource, 's3:GetObject', user);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No matching Allow statement found in identity policies (user, group, or role) or resource policy');
  });
});
