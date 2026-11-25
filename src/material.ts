// Reads Blender materials into a PBR description that three.js materials can be made from.
// Node materials are read from the shader connected to the Material Output: the Principled BSDF,
// or the Diffuse, Glossy, Glass, Emission and Transparent shaders and Mix and Add shaders
// between them, and node groups whose inputs are named like PBR parameters. Image textures are
// followed through Normal Map, Separate RGB/Color and simple colour nodes. Materials without
// nodes use their viewport or Blender Internal settings.

import { BStruct, type BlendFile } from './blend-file.js';

export type Rgba = [number, number, number, number];

export interface TextureRef {
  /** Address of the Image ID. */
  image: bigint;
  /** The image channel used, for a value taken through a Separate node or an Alpha output. */
  channel: 'r' | 'g' | 'b' | 'a' | null;
  /** UV map name from a UV Map node; empty for the default map. */
  uvMap: string;
}

export interface BlendMaterialData {
  name: string;
  /** Linear RGBA. */
  baseColor: Rgba;
  metallic: number;
  roughness: number;
  alpha: number;
  /** Linear RGB, multiplied by its strength. */
  emission: [number, number, number];
  ior: number;
  transmission: number;
  coat: number;
  coatRoughness: number;
  sheen: number;
  /** Normal map strength. */
  normalStrength: number;
  maps: {
    baseColor?: TextureRef;
    /** Alpha from a texture, usually the base colour image's alpha. */
    alpha?: TextureRef;
    metallic?: TextureRef;
    roughness?: TextureRef;
    normal?: TextureRef;
    emission?: TextureRef;
  };
  /** The base colour comes from the mesh's colour attribute. */
  vertexColor: boolean;
  /** How transparency is drawn. */
  blend: 'opaque' | 'blend' | 'clip' | 'hashed';
  alphaThreshold: number;
  backfaceCulling: boolean;
  /** Emission only: drawn without lighting. */
  unlit: boolean;
  /** What the description was read from. */
  source: 'principled' | 'nodes' | 'group' | 'viewport' | 'internal';
}

/** A node graph value: a constant, maybe replaced or scaled by a texture. */
interface Value {
  value: number[];
  texture?: TextureRef;
  vertexColor?: boolean;
}

interface Ctx {
  file: BlendFile;
  /** Links by the address of the socket they lead to. */
  links: Map<bigint, { node: BStruct; socket: BStruct }>;
  /** For nodes inside a group: the group node outside and its context. */
  parent: { group: BStruct; ctx: Ctx } | null;
  depth: number;
  warnings: Set<string>;
}

const SOCKET_VALUE: Record<number, string> = { 0: 'bNodeSocketValueFloat', 1: 'bNodeSocketValueVector', 2: 'bNodeSocketValueRGBA', 4: 'bNodeSocketValueBoolean', 6: 'bNodeSocketValueInt' };

function contextFor(file: BlendFile, tree: BStruct, parent: Ctx['parent'], warnings: Set<string>, depth = 0): Ctx {
  const links = new Map<bigint, { node: BStruct; socket: BStruct }>();
  for (const link of tree.list('links')) {
    const node = link.deref('fromnode', 'bNode');
    const socket = link.deref('fromsock', 'bNodeSocket');
    if (node && socket) links.set(link.ptr('tosock'), { node, socket });
  }
  return { file, links, parent, depth, warnings };
}

const sockets = (node: BStruct, which: 'inputs' | 'outputs') => node.list(which, 'bNodeSocket');

/** The socket with any of these names or identifiers. */
function socket(node: BStruct, which: 'inputs' | 'outputs', ...names: string[]): BStruct | undefined {
  const all = sockets(node, which);
  for (const name of names) {
    const found = all.find((s) => s.str('identifier') === name) ?? all.find((s) => s.str('name') === name);
    if (found) return found;
  }
  return undefined;
}

function defaultValue(file: BlendFile, sock: BStruct): number[] {
  const address = sock.ptr('default_value');
  if (address === 0n) return [];
  let value = file.at(address, undefined, sock.block);
  if (!value?.has('value')) value = file.at(address, SOCKET_VALUE[sock.num('type') ?? -1] ?? 'bNodeSocketValueFloat', sock.block);
  return value?.nums('value') ?? [];
}

/** Evaluates an input socket: its link, or its default value. */
function input(ctx: Ctx, sock: BStruct | undefined): Value {
  if (!sock) return { value: [] };
  const link = ctx.links.get(sock.address);
  if (!link) return { value: defaultValue(ctx.file, sock) };
  return output(ctx, link.node, link.socket);
}

function uvMapOf(ctx: Ctx, node: BStruct): string {
  const vector = ctx.links.get(socket(node, 'inputs', 'Vector')?.address ?? 0n);
  let n = vector?.node;
  // Look through Mapping nodes for a UV Map node.
  for (let i = 0; n && i < 4; i++) {
    const id = n.str('idname');
    if (id === 'ShaderNodeUVMap') return n.deref('storage')?.str('uv_map') ?? '';
    if (id === 'ShaderNodeMapping') {
      ctx.warnings.add('Mapping nodes are not applied to textures');
      n = ctx.links.get(socket(n, 'inputs', 'Vector')?.address ?? 0n)?.node;
    } else break;
  }
  return '';
}

/** Evaluates a node output. */
function output(ctx: Ctx, node: BStruct, out: BStruct): Value {
  if (ctx.depth > 32) return { value: [] };
  const id = node.str('idname') ?? '';
  const outName = out.str('identifier') ?? '';
  const deeper = { ...ctx, depth: ctx.depth + 1 };
  switch (id) {
    case 'ShaderNodeTexImage': {
      const image = node.ptr('id');
      if (image === 0n) return { value: [] };
      return { value: [], texture: { image, channel: outName === 'Alpha' ? 'a' : null, uvMap: uvMapOf(ctx, node) } };
    }
    case 'ShaderNodeSeparateRGB':
    case 'ShaderNodeSeparateColor':
    case 'ShaderNodeSeparateXYZ': {
      const src = input(deeper, socket(node, 'inputs', 'Image', 'Color', 'Vector'));
      const channel = ({ R: 'r', G: 'g', B: 'b', Red: 'r', Green: 'g', Blue: 'b', X: 'r', Y: 'g', Z: 'b' } as const)[outName as 'R'] ?? null;
      const index = channel ? 'rgb'.indexOf(channel) : 0;
      return src.texture ? { value: [], texture: { ...src.texture, channel } } : { value: [src.value[index] ?? 0] };
    }
    case 'ShaderNodeRGB':
      return { value: defaultValue(ctx.file, out) };
    case 'ShaderNodeValue':
      return { value: defaultValue(ctx.file, out) };
    case 'ShaderNodeVertexColor':
    case 'ShaderNodeAttribute':
      return { value: [1, 1, 1, 1], vertexColor: true };
    case 'ShaderNodeNormalMap':
      return input(deeper, socket(node, 'inputs', 'Color'));
    case 'ShaderNodeGroup':
      return groupOutput(deeper, node, out);
    case 'NodeGroupInput': {
      // Inside a group: continue with the group node's input outside.
      if (!ctx.parent) return { value: [] };
      return input({ ...ctx.parent.ctx, depth: ctx.depth + 1 }, socket(ctx.parent.group, 'inputs', outName));
    }
    case 'NodeReroute':
      return input(deeper, sockets(node, 'inputs')[0]);
    case 'ShaderNodeMix':
    case 'ShaderNodeMixRGB':
    case 'ShaderNodeGamma':
    case 'ShaderNodeHueSaturation':
    case 'ShaderNodeBrightContrast':
    case 'ShaderNodeRGBCurve':
    case 'ShaderNodeInvert':
    case 'ShaderNodeMath':
    case 'ShaderNodeClamp':
    case 'ShaderNodeMapRange': {
      // Colour adjustments are not evaluated: the first texture or colour feeding the node is used.
      ctx.warnings.add(`${id.replace('ShaderNode', '')} nodes are not evaluated; their first input is used`);
      for (const s of sockets(node, 'inputs')) {
        const name = s.str('name') ?? '';
        if (/^(fac|factor)$/i.test(name)) continue;
        const v = input(deeper, s);
        if (v.texture || v.vertexColor) return v;
      }
      const colour = socket(node, 'inputs', 'A_Color', 'Color1', 'Color', 'Image', 'Value');
      return colour ? input(deeper, colour) : { value: [] };
    }
    default:
      return { value: [] };
  }
}

/** A value from a node group's output, by following the group's own tree. */
function groupOutput(ctx: Ctx, group: BStruct, out: BStruct): Value {
  const tree = group.deref('id', 'bNodeTree');
  if (!tree) return { value: [] };
  const inner = contextFor(ctx.file, tree, { group, ctx }, ctx.warnings, ctx.depth + 1);
  const outputNode = tree.list('nodes', 'bNode').find((n) => n.str('idname') === 'NodeGroupOutput');
  if (!outputNode) return { value: [] };
  return input(inner, socket(outputNode, 'inputs', out.str('identifier') ?? '', out.str('name') ?? ''));
}

const num = (v: Value, fallback: number) => (Number.isFinite(v.value[0]) ? v.value[0]! : fallback);
const rgba = (v: Value, fallback: Rgba): Rgba => (v.value.length >= 3 ? [v.value[0]!, v.value[1]!, v.value[2]!, v.value[3] ?? 1] : fallback);

function blank(name: string): BlendMaterialData {
  return {
    name,
    baseColor: [0.8, 0.8, 0.8, 1],
    metallic: 0,
    roughness: 0.5,
    alpha: 1,
    emission: [0, 0, 0],
    ior: 1.5,
    transmission: 0,
    coat: 0,
    coatRoughness: 0.03,
    sheen: 0,
    normalStrength: 1,
    maps: {},
    vertexColor: false,
    blend: 'opaque',
    alphaThreshold: 0.5,
    backfaceCulling: false,
    unlit: false,
    source: 'viewport',
  };
}

/** Reads a shader into the material, from a node's BSDF/Shader output. Returns false if it isn't understood. */
function shader(ctx: Ctx, node: BStruct, m: BlendMaterialData, weight = 1): boolean {
  const id = node.str('idname') ?? '';
  const inp = (...names: string[]) => input(ctx, socket(node, 'inputs', ...names));
  switch (id) {
    case 'ShaderNodeBsdfPrincipled': {
      m.source = 'principled';
      const base = inp('Base Color');
      // A linked base colour has no factor: the texture is the colour.
      m.baseColor = base.texture ? [1, 1, 1, 1] : rgba(base, m.baseColor);
      if (base.texture) m.maps.baseColor = base.texture;
      if (base.vertexColor) m.vertexColor = true;
      const metallic = inp('Metallic');
      m.metallic = metallic.texture ? 1 : num(metallic, 0);
      if (metallic.texture) m.maps.metallic = metallic.texture;
      const roughness = inp('Roughness');
      m.roughness = roughness.texture ? 1 : num(roughness, 0.5);
      if (roughness.texture) m.maps.roughness = roughness.texture;
      const alpha = inp('Alpha');
      m.alpha = alpha.texture ? 1 : num(alpha, 1);
      if (alpha.texture) m.maps.alpha = alpha.texture;
      m.ior = num(inp('IOR'), 1.5);
      m.transmission = num(inp('Transmission Weight', 'Transmission'), 0);
      m.coat = num(inp('Coat Weight', 'Clearcoat'), 0);
      m.coatRoughness = num(inp('Coat Roughness', 'Clearcoat Roughness'), 0.03);
      m.sheen = num(inp('Sheen Weight', 'Sheen'), 0);
      readEmission(ctx, node, m, ['Emission Color', 'Emission'], 'Emission Strength', ctx.file.version >= 400 ? 0 : 1);
      readNormal(ctx, node, m);
      return true;
    }
    case 'ShaderNodeBsdfDiffuse': {
      m.source = 'nodes';
      const color = inp('Color');
      m.baseColor = color.texture ? [1, 1, 1, 1] : rgba(color, m.baseColor);
      if (color.texture) m.maps.baseColor = color.texture;
      if (color.vertexColor) m.vertexColor = true;
      m.roughness = 1;
      readNormal(ctx, node, m);
      return true;
    }
    case 'ShaderNodeBsdfGlossy':
    case 'ShaderNodeBsdfAnisotropic':
    case 'ShaderNodeBsdfMetallic': {
      m.source = 'nodes';
      const color = inp('Color', 'Base Color');
      m.baseColor = color.texture ? [1, 1, 1, 1] : rgba(color, m.baseColor);
      if (color.texture) m.maps.baseColor = color.texture;
      m.metallic = 1;
      m.roughness = num(inp('Roughness'), 0.5);
      readNormal(ctx, node, m);
      return true;
    }
    case 'ShaderNodeBsdfGlass':
    case 'ShaderNodeBsdfRefraction': {
      m.source = 'nodes';
      m.baseColor = rgba(inp('Color'), m.baseColor);
      m.roughness = num(inp('Roughness'), 0);
      m.ior = num(inp('IOR'), 1.45);
      m.transmission = 1;
      return true;
    }
    case 'ShaderNodeEmission': {
      m.source = 'nodes';
      readEmission(ctx, node, m, ['Color'], 'Strength', 1);
      if (weight === 1) {
        m.unlit = true;
        m.baseColor = [m.emission[0], m.emission[1], m.emission[2], 1];
        if (m.maps.emission) m.maps.baseColor = m.maps.emission;
      }
      return true;
    }
    case 'ShaderNodeBsdfTransparent':
      m.alpha = 0;
      return true;
    case 'ShaderNodeAddShader': {
      // Both shaders add up; read the one with a BSDF last so its base settings win.
      const [a, b] = [shaderInput(ctx, socket(node, 'inputs', 'Shader')), shaderInput(ctx, socket(node, 'inputs', 'Shader_001'))];
      const ordered = [a, b].filter((x): x is BStruct => !!x).sort((x) => (x.str('idname') === 'ShaderNodeEmission' ? -1 : 1));
      for (const s of ordered) shader(ctx, s, m, 0.5);
      return ordered.length > 0;
    }
    case 'ShaderNodeMixShader': {
      const fac = input(ctx, socket(node, 'inputs', 'Fac'));
      const a = shaderInput(ctx, socket(node, 'inputs', 'Shader'));
      const b = shaderInput(ctx, socket(node, 'inputs', 'Shader_001'));
      const transparentA = a?.str('idname') === 'ShaderNodeBsdfTransparent';
      const transparentB = b?.str('idname') === 'ShaderNodeBsdfTransparent';
      if (transparentA && b) {
        // Mix(transparent, shader, fac): fac is the opacity.
        shader(ctx, b, m);
        if (fac.texture) m.maps.alpha = fac.texture;
        else m.alpha = num(fac, 0.5);
        return true;
      }
      if (transparentB && a) {
        shader(ctx, a, m);
        m.alpha = 1 - num(fac, 0.5);
        return true;
      }
      ctx.warnings.add('Mix Shader nodes use the shader with the larger share');
      const pick = num(fac, 0.5) > 0.5 ? (b ?? a) : (a ?? b);
      return pick ? shader(ctx, pick, m) : false;
    }
    case 'ShaderNodeGroup':
      return groupShader(ctx, node, m);
    default:
      if (id) ctx.warnings.add(`${id.replace('ShaderNode', '')} shaders are not read`);
      return false;
  }
}

function shaderInput(ctx: Ctx, sock: BStruct | undefined): BStruct | null {
  if (!sock) return null;
  let link = ctx.links.get(sock.address);
  // Pass through reroutes.
  for (let i = 0; link && link.node.str('idname') === 'NodeReroute' && i < 8; i++) link = ctx.links.get(sockets(link.node, 'inputs')[0]?.address ?? 0n);
  return link?.node ?? null;
}

function readEmission(ctx: Ctx, node: BStruct, m: BlendMaterialData, colorNames: string[], strengthName: string, defaultStrength: number): void {
  const color = input(ctx, socket(node, 'inputs', ...colorNames));
  const strengthSocket = socket(node, 'inputs', strengthName);
  const strength = strengthSocket ? num(input(ctx, strengthSocket), defaultStrength) : 1;
  const c = rgba(color, [0, 0, 0, 1]);
  m.emission = [c[0] * strength, c[1] * strength, c[2] * strength];
  if (color.texture && strength > 0) {
    m.maps.emission = color.texture;
    m.emission = [strength, strength, strength];
  }
}

function readNormal(ctx: Ctx, node: BStruct, m: BlendMaterialData): void {
  const sock = socket(node, 'inputs', 'Normal');
  const link = sock ? ctx.links.get(sock.address) : undefined;
  if (!link) return;
  if (link.node.str('idname') === 'ShaderNodeNormalMap') {
    const v = input(ctx, socket(link.node, 'inputs', 'Color'));
    if (v.texture) {
      m.maps.normal = v.texture;
      m.normalStrength = num(input(ctx, socket(link.node, 'inputs', 'Strength')), 1);
    }
  } else if (link.node.str('idname') === 'ShaderNodeBump') {
    ctx.warnings.add('Bump nodes are not read');
  }
}

/** Node groups (such as the glTF PBR groups of older exporters) are read by their input names. */
function groupShader(ctx: Ctx, group: BStruct, m: BlendMaterialData): boolean {
  m.source = 'group';
  let found = false;
  // Inputs are matched by their names without spaces, case or underscores. Groups such as the
  // glTF exporter's split a parameter into a texture input (BaseColor) and a factor
  // (BaseColorFactor); a texture input that isn't linked holds no value.
  let colorFactor: Rgba | null = null;
  let emissiveFactor: [number, number, number] | null = null;
  let emissiveValue: [number, number, number] | null = null;
  for (const s of sockets(group, 'inputs')) {
    const name = (s.str('name') ?? '').toLowerCase().replace(/[\s_]/g, '');
    const v = input(ctx, s);
    if (/^(basecolou?r|albedo|diffuse|diffusecolou?r|colou?r)factor$/.test(name)) {
      colorFactor = rgba(v, [1, 1, 1, 1]);
      found = true;
    } else if (/^(basecolou?r|albedo|diffuse|diffusecolou?r|colou?r)$/.test(name)) {
      if (v.texture) m.maps.baseColor = v.texture;
      else if (!colorFactor) m.baseColor = rgba(v, m.baseColor);
      found = true;
    } else if (/^(metallicroughness|occlusionroughnessmetallic|orm|metallicroughnesstexture)$/.test(name)) {
      if (v.texture) {
        m.maps.roughness = { ...v.texture, channel: 'g' };
        m.maps.metallic = { ...v.texture, channel: 'b' };
      }
    } else if (/^(metallic|metalness)(factor)?$/.test(name)) {
      if (v.texture) m.maps.metallic = v.texture;
      else m.metallic = num(v, m.metallic);
    } else if (/^roughness(factor)?$/.test(name)) {
      if (v.texture) m.maps.roughness = v.texture;
      else m.roughness = num(v, m.roughness);
    } else if (/^normal(map)?$/.test(name)) {
      if (v.texture) m.maps.normal = v.texture;
    } else if (/^normal(scale|strength)$/.test(name)) {
      m.normalStrength = num(v, 1);
    } else if (/^(emissive|emission)(colou?r)?$/.test(name)) {
      if (v.texture) m.maps.emission = v.texture;
      else if (v.value.length >= 3) emissiveValue = [v.value[0]!, v.value[1]!, v.value[2]!];
    } else if (/^(emissive|emission)(factor|strength)$/.test(name)) {
      const f = v.value.length >= 3 ? [v.value[0]!, v.value[1]!, v.value[2]!] : [num(v, 1), num(v, 1), num(v, 1)];
      emissiveFactor = f as [number, number, number];
    } else if (/^(alpha|opacity)$/.test(name)) {
      if (v.texture) m.maps.alpha = v.texture;
      else m.alpha = num(v, m.alpha);
    } else if (/^(usecolor0|usevertexcolou?r)$/.test(name)) {
      if (num(v, 0) > 0) m.vertexColor = true;
    }
  }
  if (colorFactor) m.baseColor = colorFactor;
  if (m.maps.emission) m.emission = emissiveFactor ?? [1, 1, 1];
  else if (emissiveValue) {
    const f = emissiveFactor ?? [1, 1, 1];
    m.emission = [emissiveValue[0] * f[0], emissiveValue[1] * f[1], emissiveValue[2] * f[2]];
  }
  if (m.maps.emission && emissiveFactor && Math.max(...emissiveFactor) === 0) delete m.maps.emission;
  if (!found) ctx.warnings.add(`Node group ${group.deref('id')?.idName ?? ''} is read by its input names, and none looks like a base colour`);
  return true;
}

/** Reads a Material struct. */
export function readMaterial(file: BlendFile, ma: BStruct, warnings: Set<string>): BlendMaterialData {
  const m = blank(ma.idName);
  const version = file.version;
  // Viewport colours, used without nodes and as a fallback.
  m.baseColor = [ma.num('r') ?? 0.8, ma.num('g') ?? 0.8, ma.num('b') ?? 0.8, ma.num('a') ?? 1];
  m.metallic = ma.num('metallic') ?? 0;
  m.roughness = ma.num('roughness') ?? 0.5;

  // Transparency settings.
  const blendFlag = ma.num('blend_flag') ?? 0;
  m.backfaceCulling = (blendFlag & (1 << 2)) !== 0;
  m.alphaThreshold = ma.num('alpha_threshold') ?? 0.5;
  if (version >= 402 && ma.has('surface_render_method')) {
    m.blend = ma.num('surface_render_method') === 1 ? 'blend' : 'hashed';
  } else if (ma.has('blend_method')) {
    m.blend = ({ 3: 'clip', 4: 'hashed', 5: 'blend' } as const)[ma.num('blend_method') as 3] ?? 'opaque';
  }

  const tree = ma.num('use_nodes') || version >= 500 ? ma.deref('nodetree', 'bNodeTree') : null;
  let read = false;
  if (tree) {
    const ctx = contextFor(file, tree, null, warnings);
    const outputs = tree.list('nodes', 'bNode').filter((n) => n.str('idname') === 'ShaderNodeOutputMaterial');
    // Prefer an output for all renderers or EEVEE that has a surface connected.
    outputs.sort((a, b) => (a.num('custom1') === 0 || a.num('custom1') === 2 ? -1 : 0) - (b.num('custom1') === 0 || b.num('custom1') === 2 ? -1 : 0));
    for (const out of outputs) {
      const surface = shaderInput(ctx, socket(out, 'inputs', 'Surface'));
      if (surface && shader(ctx, surface, m)) {
        read = true;
        break;
      }
    }
  }
  if (!read && version < 280) {
    readInternal(file, ma, m);
  }
  // Settings that only matter for transparency.
  const transparent = m.alpha < 1 || !!m.maps.alpha;
  if (m.blend === 'hashed' && !transparent) m.blend = 'opaque';
  if (m.blend === 'opaque' && transparent && version < 280) m.blend = 'blend';
  return m;
}

/** Blender Internal materials (before 2.80): diffuse and specular colours, alpha and image textures. */
function readInternal(file: BlendFile, ma: BStruct, m: BlendMaterialData): void {
  m.source = 'internal';
  m.baseColor = [ma.num('r') ?? 0.8, ma.num('g') ?? 0.8, ma.num('b') ?? 0.8, 1];
  const MA_TRANSP = 1 << 16;
  m.alpha = ((ma.num('mode') ?? 0) & MA_TRANSP) !== 0 ? (ma.num('alpha') ?? 1) : 1;
  const hardness = ma.num('har') ?? 50;
  const spec = ma.num('spec') ?? 0.5;
  m.roughness = spec > 0 ? Math.min(1, Math.sqrt(2 / (hardness + 2))) : 1;
  const emit = ma.num('emit') ?? 0;
  if (emit > 0) m.emission = [m.baseColor[0] * emit, m.baseColor[1] * emit, m.baseColor[2] * emit];
  const MAP_COL = 1;
  const MAP_NORM = 2;
  const MAP_ALPHA = 128;
  const mtexField = ma.field('mtex');
  if (!mtexField) return;
  for (let i = 0; i < mtexField.length; i++) {
    const address = file.pointer(ma.offset + mtexField.offset + i * file.pointerSize);
    const mtex = address ? file.at(address, 'MTex', ma.block) : null;
    const tex = mtex?.deref('tex');
    const image = tex?.ptr('ima') ?? 0n;
    if (!mtex || !image) continue;
    const mapto = mtex.num('mapto') ?? 0;
    const ref: TextureRef = { image, channel: null, uvMap: mtex.str('uvname') ?? '' };
    if (mapto & MAP_COL && !m.maps.baseColor) {
      m.maps.baseColor = ref;
      m.baseColor = [1, 1, 1, 1];
    }
    if (mapto & MAP_NORM && !m.maps.normal) m.maps.normal = ref;
    if (mapto & MAP_ALPHA && !m.maps.alpha) m.maps.alpha = { ...ref, channel: 'a' };
  }
}
