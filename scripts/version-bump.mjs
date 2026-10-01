// npm version <x.y.z> 이 package.json 을 올리면, 같은 버전을 manifest.json 과 versions.json 에도 적는다.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.npm_package_version;
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
