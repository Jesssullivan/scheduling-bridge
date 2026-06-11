# Consumers

This page records the practical downstream usage found in the `2026-04-23` local audit.

## Direct Runtime Consumer

`MassageIthaca` is the active package consumer.

Observed usage:

- `createWizardAdapter` for local or remote Acuity scheduling
- `createRemoteWizardAdapter` for cron-time catalog reconciliation
- `extractCapabilities` as the canonical payment-capability extraction helper

Observed package version:

- `@tummycrypt/scheduling-bridge ^0.4.2`

## Boundary Companion

`scheduling-kit` is not the bridge runtime consumer, but it is the boundary companion package.
It re-exports scheduling contracts and explicitly documents that browser automation belongs in
`@tummycrypt/scheduling-bridge`.

## Operational References

`GloriousFlywheel` and adjacent infra repos reference this repo operationally for CI, runner,
or packaging policy, but they are not runtime consumers of the published bridge package.
