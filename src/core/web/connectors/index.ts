/**
 * R&D connectors: scholarly papers, package registries, vulnerability databases, GitHub and developer community
 * sources. Each returns compact Markdown for the model plus the sources it drew on (see ConnectorResult).
 */
export { ConnectorOpts } from './util';
export { classifyUrlKind } from './kind';
export { compareVersions, isPrerelease } from './versions';
export { PaperDetailsArgs, PaperSearchArgs, PaperSourceId, normalizePaperId, paperDetails, paperSearch, parseArxivAtom, rebuildInvertedAbstract } from './papers';
export { Ecosystem, PackageInfoArgs, expandComposerMinified, goModuleEscape, packageInfo } from './packages';
export { VulnLookupArgs, cvss3BaseScore, isAffected, minimalSafeVersion, osvEcosystem, vulnLookup } from './vulns';
export { GithubAction, GithubLookupArgs, githubLookup, parseRepo } from './github';
export { TechSearchArgs, TechSource, techSearch } from './tech';
