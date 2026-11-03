import type { Logger } from '@dt/common';
import type { Pool } from '@dt/db';
import { readFile } from 'node:fs/promises';
import * as WebIFC from 'web-ifc';
import { z } from 'zod';

export const IfcJob = z.object({
  schemaVersion: z.literal(1),
  modelId: z.string().uuid(),
  tenantId: z.string(),
  path: z.string(),
});
export type IfcJob = z.infer<typeof IfcJob>;

interface Element {
  guid: string;
  expressId: number;
  ifcClass: string;
  name: string | null;
  storey: string | null;
}

/**
 * Heavy background job: parse an uploaded IFC with web-ifc (WASM), extract
 * every IfcProduct (GlobalId, express ID, class, name, containing storey)
 * and the storey stack. Assets are then linked to BIM elements by GlobalId,
 * which is how live telemetry gets painted onto the 3D object in the UI.
 */
export class IfcParser {
  private api: WebIFC.IfcAPI | null = null;

  constructor(
    private readonly db: Pool,
    private readonly log: Logger,
  ) {}

  private async ifc(): Promise<WebIFC.IfcAPI> {
    if (!this.api) {
      const api = new WebIFC.IfcAPI();
      await api.Init(undefined, true);
      this.api = api;
    }
    return this.api;
  }

  async handle(job: IfcJob): Promise<void> {
    const started = Date.now();
    await this.db.query(`UPDATE bim_models SET status = 'processing', error = NULL WHERE id = $1`, [job.modelId]);
    try {
      const data = new Uint8Array(await readFile(job.path));
      const api = await this.ifc();
      const modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: false });
      try {
        const schema = api.GetModelSchema(modelID);
        const { elements, storeys } = this.extract(api, modelID);
        await this.persist(job.modelId, schema, elements, storeys);
        this.log.info({ modelId: job.modelId, schema, elements: elements.length, storeys: storeys.length, ms: Date.now() - started }, 'IFC parsed');
      } finally {
        api.CloseModel(modelID);
      }
    } catch (err) {
      const message = (err as Error).message.slice(0, 1000);
      this.log.error({ modelId: job.modelId, err: message }, 'IFC parse failed');
      await this.db.query(`UPDATE bim_models SET status = 'failed', error = $2 WHERE id = $1`, [job.modelId, message]);
    }
  }

  private extract(api: WebIFC.IfcAPI, modelID: number): { elements: Element[]; storeys: { name: string; elevation_m: number; height_m: number }[] } {
    // Storeys (sorted by elevation; height = gap to next storey)
    const storeyIds = api.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGSTOREY);
    const storeyById = new Map<number, string>();
    const rawStoreys: { name: string; elevation: number }[] = [];
    for (let i = 0; i < storeyIds.size(); i++) {
      const id = storeyIds.get(i);
      const line = api.GetLine(modelID, id);
      const name: string = line?.Name?.value ?? `Storey ${i + 1}`;
      storeyById.set(id, name);
      rawStoreys.push({ name, elevation: Number(line?.Elevation?.value ?? 0) });
    }
    rawStoreys.sort((a, b) => a.elevation - b.elevation);
    const storeys = rawStoreys.map((s, i) => ({
      name: s.name,
      elevation_m: s.elevation,
      height_m: Math.max(2.5, (rawStoreys[i + 1]?.elevation ?? s.elevation + 3.5) - s.elevation),
    }));

    // Spatial containment: element expressID → storey name
    const containment = new Map<number, string>();
    const rels = api.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
    for (let i = 0; i < rels.size(); i++) {
      const rel = api.GetLine(modelID, rels.get(i));
      const storey = storeyById.get(rel?.RelatingStructure?.value);
      if (!storey) continue;
      for (const ref of (rel.RelatedElements ?? []) as { value: number }[]) containment.set(ref.value, storey);
    }

    // Every physical product (walls, equipment, terminals, sensors, …)
    const elements: Element[] = [];
    const products = api.GetLineIDsWithType(modelID, WebIFC.IFCPRODUCT, true);
    for (let i = 0; i < products.size(); i++) {
      const expressId = products.get(i);
      const line = api.GetLine(modelID, expressId);
      const guid: string | undefined = line?.GlobalId?.value;
      if (!guid || guid.length !== 22) continue;
      elements.push({
        guid,
        expressId,
        ifcClass: api.GetNameFromTypeCode(line.type) || 'IfcProduct',
        name: line?.Name?.value ?? null,
        storey: containment.get(expressId) ?? null,
      });
    }
    return { elements, storeys };
  }

  private async persist(
    modelId: string,
    schema: string,
    elements: Element[],
    storeys: { name: string; elevation_m: number; height_m: number }[],
  ): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM bim_elements WHERE model_id = $1', [modelId]);
      for (let i = 0; i < elements.length; i += 5000) {
        const chunk = elements.slice(i, i + 5000);
        await client.query(
          `INSERT INTO bim_elements (model_id, ifc_guid, express_id, ifc_class, name, storey)
           SELECT $1, * FROM unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::text[])
           ON CONFLICT (model_id, ifc_guid) DO NOTHING`,
          [modelId, chunk.map((e) => e.guid), chunk.map((e) => e.expressId), chunk.map((e) => e.ifcClass), chunk.map((e) => e.name), chunk.map((e) => e.storey)],
        );
      }
      await client.query(
        `UPDATE bim_models SET status = 'ready', ifc_schema = $2, element_count = $3,
           storeys = CASE WHEN jsonb_array_length($4::jsonb) > 0 THEN $4::jsonb ELSE storeys END, error = NULL
         WHERE id = $1`,
        [modelId, schema, elements.length, JSON.stringify(storeys)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
