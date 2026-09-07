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
source tree's MIT license is retained beside it as `LICENSE`. The archive's
class namespaces are reconciled against the component records below by the
focused artifact test. That check is deliberately specific to this artifact:
it forces review when a class appears outside the known project or shaded
namespaces, but it does not infer licenses from package names. The two small
`org/eclipse/xtext/` utility classes are maintained directly in the pinned TLA+
source tree and are classified with the project-owned code. The same is true
of `org/apache/commons/math3/util/TLCFastMath.class`; the remaining Commons Math
namespace is the imported third-party subset.

`META-INF/LICENSE.md` contains the complete EPL-2.0 and GPL-2.0-with-Classpath-
Exception terms. `CommonsMath-LICENSE.txt` contains the complete Apache-2.0
terms used by each Apache-licensed component below. The embedded
`jline-LICENSE.txt` is stale for the bundled JLine version; the applicable
BSD-3-Clause terms and 2023 copyright are restored as `JLine-LICENSE.txt`.
Notices stripped by the upstream shading recipe are restored beside the JAR.

### TLA+ Formatter import 7aa6a56

Classes under `formatter/` were imported from Apache-2.0-licensed
[`tlaplus-formatter` commit `7aa6a566138d7b17043cadb16a9d2af62ae4944a`](https://github.com/tlaplus/tlaplus-formatter/tree/7aa6a566138d7b17043cadb16a9d2af62ae4944a).
The [TLA+ integration](https://github.com/tlaplus/tlaplus/commit/cf62ffd63fad8e89773854a39376117c2247e799)
modified the imported files: their packages were renamed to `formatter`, and
dependencies, command-line parsing, logging, and test plumbing were replaced.
The complete Apache-2.0 terms are in
`CommonsMath-LICENSE.txt`; the corresponding shipped source is the `formatter/`
directory in the pinned TLA+ source tree.

### Gson 2.14.0

Classes under `com/google/gson/` and their multi-release module descriptor are
Apache-2.0. The upstream build intended to copy a differently named license
file; the complete Apache-2.0 terms remain in `CommonsMath-LICENSE.txt`.
Corresponding source is the
[Gson source JAR](https://repo1.maven.org/maven2/com/google/code/gson/gson/2.14.0/gson-2.14.0-sources.jar).

### prettier4j 0.3.2

Classes under `com/opencastsoftware/prettier4j/` are Apache-2.0; the complete
terms are in `CommonsMath-LICENSE.txt`. Corresponding source is the
[prettier4j source JAR](https://repo1.maven.org/maven2/com/opencastsoftware/prettier4j/0.3.2/prettier4j-0.3.2-sources.jar).

### Jakarta Mail 1.6.8

Classes under `com/sun/mail/` and `javax/mail/`, plus the root module
descriptor, are EPL-2.0 or GPL-2.0 with the Classpath Exception
(`META-INF/LICENSE.md`). The notice removed by shading is restored as
`Jakarta-Mail-NOTICE.md`. Corresponding source is available as the
[mailapi source JAR](https://repo1.maven.org/maven2/com/sun/mail/mailapi/1.6.8/mailapi-1.6.8-sources.jar)
and [smtp source JAR](https://repo1.maven.org/maven2/com/sun/mail/smtp/1.6.8/smtp-1.6.8-sources.jar).

### Activation 1.1

Classes under `javax/activation/` come from the Eclipse Orbit repackaging of
Apache Geronimo Activation 1.1 and are Apache-2.0. The complete terms are in
`CommonsMath-LICENSE.txt`; the artifact's required attribution is restored as
`Activation-NOTICE.txt`. Corresponding source is the
[exact Eclipse Orbit source bundle](https://download.eclipse.org/tools/orbit/downloads/drops/R20150821153341/repository/plugins/javax.activation.source_1.1.0.v201211130549.jar).

### Apache Commons Math 3.6.1

The imported subset under `org/apache/commons/math3/`, except for the
project-owned `TLCFastMath` adapter, is Apache-2.0. Its full terms and
attribution are embedded as `CommonsMath-LICENSE.txt` and
`CommonsMath-NOTICE.txt`; its source is part of the pinned upstream TLA+ tree.

### Eclipse LSP4J 0.21.1

Classes under `org/eclipse/lsp4j/` are offered as EPL-2.0 OR BSD-3-Clause; this
redistribution uses EPL-2.0, whose complete terms are embedded in
`META-INF/LICENSE.md`. The upstream dual-license notice removed by the shading
recipe is restored as `LSP4J-NOTICE.md`. Corresponding source is
available in the [debug source JAR](https://repo1.maven.org/maven2/org/eclipse/lsp4j/org.eclipse.lsp4j.debug/0.21.1/org.eclipse.lsp4j.debug-0.21.1-sources.jar),
[JSON-RPC source JAR](https://repo1.maven.org/maven2/org/eclipse/lsp4j/org.eclipse.lsp4j.jsonrpc/0.21.1/org.eclipse.lsp4j.jsonrpc-0.21.1-sources.jar),
and [JSON-RPC debug source JAR](https://repo1.maven.org/maven2/org/eclipse/lsp4j/org.eclipse.lsp4j.jsonrpc.debug/0.21.1/org.eclipse.lsp4j.jsonrpc.debug-0.21.1-sources.jar).

### JLine 3.25.0

Classes under `org/jline/` are BSD-3-Clause (`JLine-LICENSE.txt`). Their source
is available from the pinned [JLine 3.25.0 tree](https://github.com/jline/jline3/tree/jline-parent-3.25.0).

The pinned [upstream source tree](https://github.com/tlaplus/tlaplus/tree/9787e65714c37d94eebab40774bff401bd9f616d)
and its [standalone-JAR build recipe](https://github.com/tlaplus/tlaplus/blob/9787e65714c37d94eebab40774bff401bd9f616d/tlatools/org.lamport.tlatools/customBuild.xml)
are the authoritative source and dependency inventory for this exact artifact.
