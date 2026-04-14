# AGENTS

## Purpose

`acuity-middleware` publishes `@tummycrypt/scheduling-bridge`.

This repo is the canonical owner of:

- Acuity browser automation
- the remote scheduling bridge protocol
- Modal runtime execution for the Acuity path
- bridge runtime health and release metadata

It is not the owner of:

- homegrown scheduling backend behavior
- adopter-specific payment policy
- site-specific booking UX

## Cross-Repo Boundary

### `scheduling-kit`

Owns:

- homegrown backend
- shared scheduling and payment primitives
- generic reusable UI components

This repo must not absorb those concerns.

### `MassageIthaca`

Owns:

- business settings
- admin/operator UX
- explicit site policy
- composition of bridge and package contracts into public booking surfaces

This repo must not require app-local shims to define Acuity behavior.

## Hard Rules

1. All Acuity scheduling semantics must be bridge-owned.
2. Modal runtime truth must be visible enough for downstream rollout checks.
3. Bazel metadata, package metadata, and runtime release metadata must not
   drift.
4. Downstream adopters must be able to assert the expected bridge version and
   release tuple.

## Current Reset State

- Local Bazel metadata was aligned to package version `0.3.1`.
- Modal deploy is still not a first-class CI/CD release unit.
- The next required step is explicit bridge protocol and runtime release truth,
  not more implicit rollout assumptions.
