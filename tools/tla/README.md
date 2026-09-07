# Vendored TLA+ checker

`tla2tools.jar` is the exact standalone checker used by this repository's
green August 2026 proof runs. It is committed here because TLA+'s `v1.8.0`
prerelease tag and release asset are deliberately replaced by upstream builds;
pinning their URL plus a checksum repeatedly preserved integrity but broke the
gate's availability.

- SHA-256: `eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a`
- Size: 4,487,757 bytes
- Upstream revision: `9787e65714c37d94eebab40774bff401bd9f616d`
- Upstream build timestamp: `2026-08-21T15:59:22.332Z`
- Former upstream release asset ID: `523952485`
- Publishing evidence: <https://github.com/tlaplus/tlaplus/actions/runs/32499361502/job/97646785779>

`scripts/tla.sh` verifies the digest before every run and has no download or
cache fallback. Updating the checker therefore requires an explicit reviewed
blob and provenance change followed by all six TLA targets. The upstream source
and this distribution are MIT licensed; the notice is retained in `LICENSE`.
