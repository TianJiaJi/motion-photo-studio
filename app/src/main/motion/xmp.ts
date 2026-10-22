import { SaxesParser } from 'saxes';
import { safeInteger } from './io.ts';
import type { MotionProfile } from './profiles.ts';

export const NS = {
  camera: 'http://ns.google.com/photos/1.0/camera/',
  container: 'http://ns.google.com/photos/1.0/container/',
  item: 'http://ns.google.com/photos/1.0/container/item/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
};

type Attribute = { uri: string; local: string; value: string };
type Element = { uri: string; local: string; attributes: Attribute[]; children: Element[]; text: string };
export type MotionMetadata = {
  modern: boolean; legacy: boolean; videoLength: number; timestampUs: number;
  primaryPadding: number; videoPadding: number;
};

function parseTree(xml: string): Element {
  if (Buffer.byteLength(xml) > 1024 * 1024) throw new Error('XMP exceeds parser bound');
  const root: Element = { uri: '', local: '#document', attributes: [], children: [], text: '' };
  const stack = [root];
  let nodes = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new Error('XMP DOCTYPE is forbidden'); });
  parser.on('error', error => { throw error; });
  parser.on('opentag', tag => {
    if (++nodes > 1024 || stack.length > 32) throw new Error('XMP tree exceeds parser bound');
    const node: Element = {
      uri: tag.uri, local: tag.local, attributes: Object.values(tag.attributes), children: [], text: '',
    };
    stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  parser.on('closetag', () => { stack.pop(); });
  parser.on('text', text => { stack.at(-1)!.text += text; });
  parser.on('cdata', text => { stack.at(-1)!.text += text; });
  parser.write(xml).close();
  return root;
}

function all(root: Element): Element[] {
  return [root, ...root.children.flatMap(all)];
}

function property(root: Element, uri: string, local: string): string | undefined {
  const values: string[] = [];
  for (const node of all(root)) {
    if (node.uri === uri && node.local === local) values.push(node.text.trim());
    for (const attribute of node.attributes) {
      if (attribute.uri === uri && attribute.local === local) values.push(attribute.value.trim());
    }
  }
  if (values.length > 1) throw new Error(`Duplicate XMP property: ${local}`);
  return values[0];
}

function integer(value: string | undefined, label: string, defaultValue?: number): number {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (value === undefined || !/^-?\d+$/.test(value)) throw new Error(`Invalid XMP integer: ${label}`);
  return safeInteger(Number(value), label, label.includes('Timestamp') ? -1 : 0);
}

export function parseMotionXmp(xml: string): MotionMetadata {
  const root = parseTree(xml);
  const camera = (name: string) => property(root, NS.camera, name);
  const modern = camera('MotionPhoto') === '1';
  const legacy = camera('MicroVideo') === '1';
  if (!modern && !legacy) throw new Error('No enabled Motion Photo metadata');
  if (modern && camera('MotionPhotoVersion') !== '1') throw new Error('Unsupported Motion Photo version');
  if (legacy && camera('MicroVideoVersion') !== '1') throw new Error('Unsupported MicroVideo version');
  const timestampUs = integer(camera(modern ? 'MotionPhotoPresentationTimestampUs' : 'MicroVideoPresentationTimestampUs'), 'TimestampUs', -1);
  if (!modern) {
    return {
      modern, legacy, videoLength: integer(camera('MicroVideoOffset'), 'MicroVideoOffset'),
      timestampUs, primaryPadding: 0, videoPadding: 0,
    };
  }
  const directories = all(root).filter(node => node.uri === NS.container && node.local === 'Directory');
  if (directories.length !== 1) throw new Error('Expected one Container Directory');
  const directory = directories[0]!;
  const sequences = directory.children.filter(node => node.uri === NS.rdf && node.local === 'Seq');
  if (sequences.length !== 1) throw new Error('Expected RDF Seq in Container Directory');
  const rows = sequences[0]!.children;
  if (rows.length !== 2 || rows.some(row => row.uri !== NS.rdf || row.local !== 'li')) {
    throw new Error('PoC supports exactly Primary and MotionPhoto items');
  }
  const items = rows.map(row => {
    const children = row.children.filter(node => node.uri === NS.container && node.local === 'Item');
    if (children.length !== 1) throw new Error('Expected Container Item');
    const item = children[0]!;
    return {
      mime: property(item, NS.item, 'Mime'), semantic: property(item, NS.item, 'Semantic'),
      length: integer(property(item, NS.item, 'Length'), 'Item Length', 0),
      padding: integer(property(item, NS.item, 'Padding'), 'Item Padding', 0),
    };
  });
  const primary = items[0]!; const video = items[1]!;
  if (primary.mime !== 'image/jpeg' || primary.semantic !== 'Primary' || primary.length !== 0) {
    throw new Error('Invalid Primary JPEG item');
  }
  if (video.mime !== 'video/mp4' || video.semantic !== 'MotionPhoto' || video.length === 0) {
    throw new Error('Invalid MotionPhoto MP4 item');
  }
  // Strict consistency is an authoring check. Do not infer that every reader consults legacy fields.
  if (legacy && integer(camera('MicroVideoOffset'), 'MicroVideoOffset') !== video.length + video.padding) {
    throw new Error('Conflicting modern/legacy video offset');
  }
  if (legacy && integer(camera('MicroVideoPresentationTimestampUs'), 'Legacy TimestampUs', -1) !== timestampUs) {
    throw new Error('Conflicting modern/legacy timestamp');
  }
  return { modern, legacy, videoLength: video.length, timestampUs, primaryPadding: primary.padding, videoPadding: video.padding };
}

export function buildXmp(profile: MotionProfile, videoLength: number, timestampUs: number): string {
  safeInteger(videoLength, 'video length', 1);
  safeInteger(timestampUs, 'presentation timestamp', -1);
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="${NS.rdf}">
  <rdf:Description rdf:about="" xmlns:GCamera="${NS.camera}" xmlns:Container="${NS.container}" xmlns:Item="${NS.item}"
   GCamera:MotionPhoto="1" GCamera:MotionPhotoVersion="1" GCamera:MotionPhotoPresentationTimestampUs="${timestampUs}"${profile.legacy ? `
   GCamera:MicroVideo="1" GCamera:MicroVideoVersion="1" GCamera:MicroVideoOffset="${videoLength}" GCamera:MicroVideoPresentationTimestampUs="${timestampUs}"` : ''}>
   <Container:Directory><rdf:Seq>
    <rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="0"/></rdf:li>
    <rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${videoLength}" Item:Padding="0"/></rdf:li>
   </rdf:Seq></Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
}
