export const QUERIES = {
  // -- Ingestion --

  upsertPackage: `
    MERGE (p:Package {name: $name})
    SET p.description = $description,
        p.latestVersion = $latestVersion
    RETURN p
  `,

  upsertVersion: `
    MERGE (v:Version {id: $id})
    SET v.package = $package,
        v.version = $version,
        v.publishedAt = $publishedAt
    WITH v
    MATCH (p:Package {name: $package})
    MERGE (p)-[:HAS_VERSION]->(v)
    RETURN v
  `,

  createDependency: `
    MATCH (src:Package {name: $from})
    MATCH (dep:Package {name: $to})
    MERGE (src)-[r:DEPENDS_ON]->(dep)
    SET r.versionRange = $versionRange
    RETURN r
  `,

  upsertMaintainer: `
    MERGE (m:Maintainer {username: $username})
    SET m.email = $email
    RETURN m
  `,

  linkMaintainerToPackage: `
    MATCH (m:Maintainer {username: $username})
    MATCH (p:Package {name: $package})
    MERGE (m)-[:PUBLISHES]->(p)
    RETURN m, p
  `,

  // -- Blast radius (dependency layer) --

  downstreamBlastRadius: `
    MATCH path = (compromised:Package {name: $package})<-[:DEPENDS_ON*1..10]-(affected:Package)
    RETURN DISTINCT affected.name AS package,
           length(path) AS depth
    ORDER BY depth
  `,

  // -- Lateral movement (maintainer layer) --

  sharedMaintainerRisk: `
    MATCH (compromised:Package {name: $package})<-[:PUBLISHES]-(m:Maintainer)-[:PUBLISHES]->(other:Package)
    WHERE other.name <> $package
    RETURN m.username AS maintainer,
           collect(DISTINCT other.name) AS atRiskPackages
  `,

  maintainerBlastRadius: `
    MATCH (compromised:Package {name: $package})<-[:PUBLISHES]-(m:Maintainer)-[:PUBLISHES]->(other:Package)
    WHERE other.name <> $package
    WITH other
    MATCH path = (other)<-[:DEPENDS_ON*1..10]-(downstream:Package)
    RETURN DISTINCT downstream.name AS package,
           other.name AS entryPoint,
           length(path) + 1 AS depth
    ORDER BY depth
  `,

  // -- Temporal exposure --

  temporalExposure: `
    MATCH (p:Package {name: $package})-[:HAS_VERSION]->(v:Version)
    WHERE v.publishedAt >= $windowStart
      AND v.publishedAt <= $windowEnd
    RETURN v.version AS version,
           v.publishedAt AS publishedAt
    ORDER BY v.publishedAt
  `,

  consumersInWindow: `
    MATCH (p:Package {name: $package})<-[:DEPENDS_ON]-(consumer:Package)
    RETURN consumer.name AS consumer
  `,

  // -- Typosquat detection --

  allPackageNames: `
    MATCH (p:Package)
    RETURN p.name AS name
  `,
} as const;
