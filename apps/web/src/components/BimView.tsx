'use client';

import type { AssetFeature } from '@dt/contracts';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { endpoints, session, type BimModel } from '@/lib/api';
import { assetStatus, useTwin, type LiveStatus } from '@/lib/store';
import { STATUS_COLORS, TYPE_BOX } from '@/lib/theme';

/**
 * BIM viewport (Three.js).
 *
 * Coordinates: model-local ENU metres (x east, y north, z up) map to
 * Three.js as (x, z, −y) — the same Y-up convention web-ifc emits, so
 * schematic assets and real IFC geometry share one frame.
 *
 * Modes
 *   • schematic — storey slabs + one box per asset at its local placement
 *   • IFC       — full geometry streamed by web-ifc (WASM) in the browser;
 *                 meshes whose GlobalId matches an asset are tinted live.
 */

const toThree = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);

interface SceneHandles {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  modelGroup: THREE.Group;
  assetGroup: THREE.Group;
  /** assetId → schematic box mesh */
  assetMeshes: Map<string, THREE.Mesh>;
  /** assetId → IFC meshes for that element */
  ifcMeshes: Map<string, THREE.Mesh[]>;
  label: CSS2DObject;
}

function statusMaterial(status: LiveStatus, selected: boolean): THREE.MeshStandardMaterial {
  const c = STATUS_COLORS[status];
  return new THREE.MeshStandardMaterial({
    color: c.hex,
    emissive: c.hex,
    emissiveIntensity: status === 'critical' ? 0.6 : selected ? 0.35 : 0.12,
    roughness: 0.45,
    metalness: 0.15,
  });
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => m.dispose());
    }
  });
  group.clear();
}

/** Storey slabs + translucent envelope for models without IFC geometry */
function buildSchematic(parent: THREE.Group, model: BimModel): void {
  const group = new THREE.Group();
  group.name = 'schematic';
  parent.add(group);
  const storeys = model.storeys.length ? model.storeys : [{ name: 'Ground', elevation_m: 0, height_m: 4 }];
  const slabMat = new THREE.MeshStandardMaterial({ color: 0x2a3a55, transparent: true, opacity: 0.55, roughness: 0.9 });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x6f8fc4, transparent: true, opacity: 0.7 });
  for (const s of storeys) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(model.widthM, 0.25, model.depthM), slabMat.clone());
    slab.position.set(0, s.elevation_m - 0.125, 0);
    slab.receiveShadow = true;
    group.add(slab);
    const shell = new THREE.BoxGeometry(model.widthM, s.height_m, model.depthM);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(shell), edgeMat.clone());
    edges.position.set(0, s.elevation_m + s.height_m / 2, 0);
    shell.dispose();
    group.add(edges);
  }
  const grid = new THREE.GridHelper(Math.max(model.widthM, model.depthM) * 2, 40, 0x334466, 0x1d2840);
  grid.position.y = -0.3;
  group.add(grid);
}

/** Stream IFC geometry with web-ifc and index meshes by expressID */
async function loadIfc(
  group: THREE.Group,
  modelId: string,
  onProgress: (msg: string) => void,
): Promise<Map<number, THREE.Mesh[]>> {
  const WebIFC = await import('web-ifc');
  const ifc = new WebIFC.IfcAPI();
  ifc.SetWasmPath('/wasm/', true);
  await ifc.Init(undefined, true); // single-thread: no COOP/COEP headers required
  onProgress('Downloading IFC…');
  const data = new Uint8Array(await endpoints.bimFile(modelId));
  onProgress('Building geometry…');
  const modelID = ifc.OpenModel(data, { COORDINATE_TO_ORIGIN: true });
  const byExpress = new Map<number, THREE.Mesh[]>();
  const matCache = new Map<string, THREE.MeshStandardMaterial>();

  ifc.StreamAllMeshes(modelID, (flat) => {
    const placed = flat.geometries;
    for (let i = 0; i < placed.size(); i++) {
      const pg = placed.get(i);
      const geom = ifc.GetGeometry(modelID, pg.geometryExpressID);
      const verts = ifc.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = ifc.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const buffer = new THREE.BufferGeometry();
      // web-ifc interleaves [x, y, z, nx, ny, nz]
      const inter = new THREE.InterleavedBuffer(verts, 6);
      buffer.setAttribute('position', new THREE.InterleavedBufferAttribute(inter, 3, 0));
      buffer.setAttribute('normal', new THREE.InterleavedBufferAttribute(inter, 3, 3));
      buffer.setIndex(new THREE.BufferAttribute(idx, 1));
      geom.delete();

      const { x, y, z, w } = pg.color;
      const key = `${x.toFixed(3)}|${y.toFixed(3)}|${z.toFixed(3)}|${w.toFixed(3)}`;
      let mat = matCache.get(key);
      if (!mat) {
        mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(x, y, z), transparent: w < 1, opacity: w, side: THREE.DoubleSide, roughness: 0.8 });
        matCache.set(key, mat);
      }
      const mesh = new THREE.Mesh(buffer, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(pg.flatTransformation);
      mesh.userData.expressId = flat.expressID;
      mesh.userData.baseMaterial = mat;
      group.add(mesh);
      const list = byExpress.get(flat.expressID) ?? [];
      list.push(mesh);
      byExpress.set(flat.expressID, list);
    }
  });
  ifc.CloseModel(modelID);
  onProgress('');
  return byExpress;
}

export default function BimView() {
  const host = useRef<HTMLDivElement>(null);
  const handles = useRef<SceneHandles | null>(null);
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'schematic' | 'ifc'>('schematic');
  const [uploading, setUploading] = useState(false);

  const models = useTwin((s) => s.models);
  const modelId = useTwin((s) => s.selectedModelId);
  const assets = useTwin((s) => s.assets);
  const version = useTwin((s) => s.version);
  const selectedId = useTwin((s) => s.selectedAssetId);
  const model = models.find((m) => m.id === modelId) ?? null;

  // ---- Scene bootstrap ----------------------------------------------------------
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.setClearColor(0x0b1220);
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);

    const labels = new CSS2DRenderer();
    labels.setSize(el.clientWidth, el.clientHeight);
    labels.domElement.className = 'bim-labels';
    el.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0b1220, 150, 600);
    const camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.1, 5000);
    camera.position.set(55, 45, 60);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.target.set(0, 4, 0);

    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a2233, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(60, 120, 40);
    sun.castShadow = true;
    scene.add(sun);

    const modelGroup = new THREE.Group();
    const assetGroup = new THREE.Group();
    scene.add(modelGroup, assetGroup);

    const tag = document.createElement('div');
    tag.className = 'bim-tag';
    const label = new CSS2DObject(tag);
    label.visible = false;
    scene.add(label);

    handles.current = { renderer, labels, scene, camera, controls, modelGroup, assetGroup, assetMeshes: new Map(), ifcMeshes: new Map(), label };

    // Click → select asset (schematic box or IFC element bound to an asset)
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downAt = { x: 0, y: 0 };
    const onDown = (e: PointerEvent) => (downAt = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return; // was a drag
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects([...assetGroup.children, ...modelGroup.children], false).find((h) => h.object.userData.assetId);
      useTwin.getState().select(hit ? (hit.object.userData.assetId as string) : null);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    const resize = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      labels.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    resize.observe(el);

    let raf = 0;
    const clock = new THREE.Clock();
    const loop = () => {
      const t = clock.getElapsedTime();
      // Critical assets breathe so they read at a glance
      for (const mesh of handles.current?.assetMeshes.values() ?? []) {
        const m = mesh.material as THREE.MeshStandardMaterial;
        if (mesh.userData.status === 'critical') m.emissiveIntensity = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 6));
      }
      controls.update();
      renderer.render(scene, camera);
      labels.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      controls.dispose();
      disposeGroup(modelGroup);
      disposeGroup(assetGroup);
      renderer.dispose();
      el.innerHTML = '';
      handles.current = null;
    };
  }, []);

  // ---- Model geometry (schematic or IFC) -------------------------------------------
  useEffect(() => {
    const h = handles.current;
    if (!h || !model) return;
    let cancelled = false;
    disposeGroup(h.modelGroup);
    h.ifcMeshes.clear();
    buildSchematic(h.modelGroup, model);
    setMode('schematic');

    const span = Math.max(model.widthM, model.depthM);
    h.camera.position.set(span * 1.0, span * 0.85, span * 1.15);
    h.controls.target.set(0, 4, 0);

    if (model.status === 'ready') {
      setMessage('Loading IFC engine…');
      (async () => {
        try {
          const [byExpress, elements] = await Promise.all([loadIfc(h.modelGroup, model.id, setMessage), endpoints.bimElements(model.id)]);
          if (cancelled) return;
          // GlobalId → expressID → meshes → assetId
          const guidToExpress = new Map(elements.map((e) => [e.ifcGuid.trim(), e.expressId]));
          for (const a of useTwin.getState().assets) {
            const guid = a.properties.bim?.modelId === model.id ? a.properties.bim.ifcGuid : null;
            const express = guid ? guidToExpress.get(guid) : undefined;
            const meshes = express !== undefined ? byExpress.get(express) : undefined;
            if (meshes) {
              meshes.forEach((m) => (m.userData.assetId = a.id));
              h.ifcMeshes.set(a.id, meshes);
            }
          }
          const schematic = h.modelGroup.getObjectByName('schematic');
          if (schematic) schematic.visible = false;
          setMode('ifc');
        } catch (err) {
          if (!cancelled) setMessage(`IFC load failed — showing schematic (${(err as Error).message})`);
        }
      })();
    } else {
      setMessage(model.status === 'processing' ? 'IFC is being processed — schematic shown meanwhile' : '');
    }
    return () => {
      cancelled = true;
    };
  }, [model?.id, model?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Asset boxes + live colouring --------------------------------------------------
  useEffect(() => {
    const h = handles.current;
    if (!h || !model) return;
    const devices = useTwin.getState().devices;
    const inModel = assets.filter((a) => a.properties.bim?.modelId === model.id);
    const seen = new Set<string>();

    for (const a of inModel) {
      seen.add(a.id);
      const status = assetStatus(a, devices);
      const selected = a.id === selectedId;
      const ifcMeshes = h.ifcMeshes.get(a.id);

      if (mode === 'ifc' && ifcMeshes) {
        // Tint the real IFC element; keep its geometry
        for (const m of ifcMeshes) {
          if (m.userData.status !== status || m.userData.selected !== selected) {
            if (m.material !== m.userData.baseMaterial) (m.material as THREE.Material).dispose();
            m.material = status === 'unknown' && !selected ? (m.userData.baseMaterial as THREE.Material) : statusMaterial(status, selected);
            m.userData.status = status;
            m.userData.selected = selected;
          }
        }
        h.assetMeshes.get(a.id)?.removeFromParent();
        h.assetMeshes.delete(a.id);
        continue;
      }

      let mesh = h.assetMeshes.get(a.id);
      if (!mesh) {
        const [w, d, ht] = TYPE_BOX[a.properties.type] ?? TYPE_BOX.other!;
        mesh = new THREE.Mesh(new THREE.BoxGeometry(w, ht, d), statusMaterial(status, selected));
        const { x, y, z } = a.properties.bim!.local;
        mesh.position.copy(toThree(x, y, z + ht / 2));
        mesh.castShadow = true;
        mesh.userData.assetId = a.id;
        h.assetGroup.add(mesh);
        h.assetMeshes.set(a.id, mesh);
      }
      if (mesh.userData.status !== status || mesh.userData.selected !== selected) {
        (mesh.material as THREE.Material).dispose();
        mesh.material = statusMaterial(status, selected);
        mesh.userData.status = status;
        mesh.userData.selected = selected;
        mesh.scale.setScalar(selected ? 1.25 : 1);
      }
    }
    for (const [id, mesh] of h.assetMeshes) {
      if (!seen.has(id)) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        mesh.removeFromParent();
        h.assetMeshes.delete(id);
      }
    }

    // Floating label on the selection
    const sel = selectedId ? inModel.find((a) => a.id === selectedId) : null;
    if (sel?.properties.bim) {
      const { x, y, z } = sel.properties.bim.local;
      const status = assetStatus(sel, devices);
      h.label.position.copy(toThree(x, y, z + 3));
      (h.label.element as HTMLDivElement).innerHTML = `<b>${sel.properties.name}</b><span style="color:${STATUS_COLORS[status].css}">● ${STATUS_COLORS[status].label}</span>`;
      h.label.visible = true;
    } else {
      h.label.visible = false;
    }
  }, [assets, version, selectedId, model, mode]);

  // ---- Focus camera on selection --------------------------------------------------------
  useEffect(() => {
    const h = handles.current;
    const a: AssetFeature | undefined = selectedId ? useTwin.getState().assetsById.get(selectedId) : undefined;
    if (!h || !a?.properties.bim || a.properties.bim.modelId !== model?.id) return;
    const { x, y, z } = a.properties.bim.local;
    const target = toThree(x, y, z + 1);
    h.controls.target.copy(target);
    h.camera.position.copy(target.clone().add(new THREE.Vector3(14, 12, 16)));
  }, [selectedId, model?.id]);

  const upload = async (file: File) => {
    if (!model) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('name', file.name.replace(/\.ifc$/i, ''));
      form.append('lon', String(model.lon));
      form.append('lat', String(model.lat));
      form.append('rotationDeg', String(model.rotationDeg));
      const created = await endpoints.uploadIfc(form);
      setMessage(`Uploaded "${created.name}" — parsing in background`);
      const st = useTwin.getState();
      st.setModels([...st.models, created]);
    } catch (err) {
      setMessage(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="viewport">
      <div ref={host} className="bim-canvas" />
      <div className="bim-toolbar">
        <select value={modelId ?? ''} onChange={(e) => useTwin.getState().selectModel(e.target.value || null)}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · {m.status}
            </option>
          ))}
        </select>
        <span className="pill">{mode === 'ifc' ? `IFC · ${model?.elementCount ?? 0} elements` : 'Schematic'}</span>
        {session.canWrite() && (
          <label className="btn btn-ghost">
            {uploading ? 'Uploading…' : 'Upload IFC'}
            <input type="file" accept=".ifc" hidden disabled={uploading} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
        )}
      </div>
      {message && <div className="bim-message">{message}</div>}
      {!model && <div className="empty">No BIM models yet — upload an IFC file to begin.</div>}
    </div>
  );
}
