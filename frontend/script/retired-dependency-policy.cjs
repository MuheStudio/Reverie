'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {collectInstalledNpmLicenses}=require('./collect-installed-npm-licenses.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function assertNoRetiredPackages(records) {
  if(!Array.isArray(records)||records.some(r=>r.name==='elephantops'))throw Error('Retired elephantops remains in production dependency graph');
}
function assertProductionRetirement(frontend) {
  const scratch=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reverie-npm-retirement-'));
  try {
    const rows=collectInstalledNpmLicenses(frontend,path.join(scratch,'notices'));
    assertNoRetiredPackages(rows);
    const records=rows.map(r=>({name:r.name,version:r.version,license:r.license,manifestSha256:r.manifestSha256,sourcePath:r.sourcePath,licenseTextStatus:r.licenseTextStatus}));
    return {schema:'reverie.production-dependency-retirement.v1',passed:true,retired:['elephantops'],entries:records.length,records,sha256:hash(JSON.stringify(records)),scope:'Reachable installed npm production graph, not an audit of every third-party source or asset.'};
  } finally {fs.rmSync(scratch,{recursive:true,force:true});}
}
module.exports={assertNoRetiredPackages,assertProductionRetirement};
