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
blob and provenance change followed by all six TLA targets.

This is the unmodified upstream standalone JAR, not an MIT-only distribution.
The JAR embeds the TLA+ Tools artifact notice as `License.txt`; the pinned
source tree's MIT license is retained beside it as `LICENSE`. The fat JAR also
bundles third-party code and retains upstream notices, including:

- Jakarta Mail 1.6.8 under EPL-2.0 or GPL-2.0 with the Classpath Exception
  (`META-INF/LICENSE.md`). Its corresponding source is available as the
  [mailapi source JAR](https://repo1.maven.org/maven2/com/sun/mail/mailapi/1.6.8/mailapi-1.6.8-sources.jar)
  and [smtp source JAR](https://repo1.maven.org/maven2/com/sun/mail/smtp/1.6.8/smtp-1.6.8-sources.jar).
- Apache Commons Math under Apache-2.0 (`CommonsMath-LICENSE.txt` and
  `CommonsMath-NOTICE.txt`).
- JLine under BSD-3-Clause (`jline-LICENSE.txt`).

The pinned [upstream source tree](https://github.com/tlaplus/tlaplus/tree/9787e65714c37d94eebab40774bff401bd9f616d)
and its [standalone-JAR build recipe](https://github.com/tlaplus/tlaplus/blob/9787e65714c37d94eebab40774bff401bd9f616d/tlatools/org.lamport.tlatools/customBuild.xml)
are the authoritative source and dependency inventory for this exact artifact.
