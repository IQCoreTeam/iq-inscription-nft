import {readFile} from 'node:fs/promises';
import {assertPreparedKit} from './kit.mjs';
import {resolveAssetPath} from '../service/render-engine.mjs';
import {publishKitArtifacts} from '../client/publish-kit.mjs';

// Node host boundary adds kit provenance and rooted-file access. The graph and
// receipt recovery are shared with the browser publisher, not duplicated here.
export async function publishRenderKit(kit,assetRoot,context,checkpoint) {
  if(kit===null)return null;
  assertPreparedKit(kit);
  return publishKitArtifacts(kit,async file=>readFile(await resolveAssetPath(file,assetRoot)),context,checkpoint);
}
