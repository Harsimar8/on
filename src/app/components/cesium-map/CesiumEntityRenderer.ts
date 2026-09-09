import * as Cesium from "cesium";
import { Entity } from "../../core/models/Entity";
import { EntityIconFactory } from "../../core/factories/EntityIconFactory";
import { EditorState } from "../../core/state/EditorState";
import { TeamFilterService } from "../../core/services/TeamFilterService";
import { Team } from "../../core/types/Team";
import { TeamFilter } from "../../core/models/TeamFilter";
import { Cesium3DRadarCoverage } from "./CesiumRadarCoverage";

export class CesiumEntityRenderer {
    // Stores 3D radar entities by entity.id so they can be cleaned up cleanly
    private readonly radarEntities = new Map<string, Cesium.Entity[]>();

    // Remembers the exact position we last BUILT radar coverage for, per
    // entity id. If render() gets called again (camera move, hover,
    // selection change, anything) and the position hasn't actually
    // changed, we skip rebuilding entirely and just re-add the cached
    // entities. Without this, every single render() call re-samples
    // terrain from scratch - and since terrain LOD changes continuously as
    // the camera moves/zooms, that made the whole ray fan visibly "swim"
    // on every pan/zoom instead of only updating when the radar moves.
    private readonly lastBuiltPosition = new Map<string, { lon: number; lat: number }>();

    private renderGeneration = 0;

    constructor(
        private viewer: Cesium.Viewer,
        private terrainProvider: Cesium.TerrainProvider,
        private teamFilterService: TeamFilterService,
        private editorState: EditorState
    ) {}

    render(entities: Entity[]): void {
        const myGeneration = ++this.renderGeneration;
        const filter = this.teamFilterService.cesiumFilter();

        // 1. Remove all billboards and standard entities
        this.viewer.entities.removeAll();

        // 2. Remove previously created 3D radar entities from the scene
        // (but keep them in `radarEntities` - we may just re-add the same
        // objects below instead of rebuilding them).
        for (const [_, entityList] of this.radarEntities) {
            for (const ent of entityList) {
                this.viewer.entities.remove(ent);
            }
        }

        // 3. Re-draw visible entities
        for (const entity of entities) {
            if (
                (filter === TeamFilter.Blue && entity.team !== Team.Blue) ||
                (filter === TeamFilter.Red && entity.team !== Team.Red)
            ) {
                continue;
            }

            this.drawRadar(entity);
            this.drawTeamDot(entity);

            if (entity.definition.entityType === "RadarSite") {
                this.drawTerrainRadarCone(entity, myGeneration);
            }
        }

        this.viewer.scene.requestRender();
    }

    private async drawTerrainRadarCone(entity: Entity, myGeneration: number): Promise<void> {
        const lastPos = this.lastBuiltPosition.get(entity.id);
        const positionUnchanged =
            lastPos !== undefined &&
            lastPos.lon === entity.position.longitude &&
            lastPos.lat === entity.position.latitude;

        const cached = this.radarEntities.get(entity.id);

        if (positionUnchanged && cached) {
            // Nothing actually moved - just re-add the SAME entity objects
            // we already built, instead of re-sampling terrain and
            // rebuilding everything from scratch.
            for (const ent of cached) {
                this.viewer.entities.add(ent);
            }
            this.viewer.scene.requestRender();
            return;
        }

        try {
            const radar3DEntities = await Cesium3DRadarCoverage.create3DRadarZones(
                this.viewer,
                this.terrainProvider,
                {
                    longitude: entity.position.longitude,
                    latitude: entity.position.latitude,
                    antennaMastHeight: 25,
                    numAzimuths: 144,
                    showDebugRays: true,
                    zones: Cesium3DRadarCoverage.DEFAULT_3D_ZONES
                }
            );

            // If a newer render() has started since this call began (e.g.
            // the entity moved again before this finished), discard this
            // stale result instead of adding it.
            if (myGeneration !== this.renderGeneration) {
                for (const ent of radar3DEntities) {
                    this.viewer.entities.remove(ent);
                }
                return;
            }

            this.radarEntities.set(entity.id, radar3DEntities);
            this.lastBuiltPosition.set(entity.id, {
                lon: entity.position.longitude,
                lat: entity.position.latitude
            });

            this.viewer.scene.requestRender();
        } catch (err) {
            console.error("Failed to render 3D radar coverage:", err);
        }
    }


    private drawRadar(entity: Entity): void {
    const selected =
        this.editorState.selectedEntity()?.id === entity.id;

    this.viewer.entities.add({
        id: entity.id,

        position: Cesium.Cartesian3.fromDegrees(
            entity.position.longitude,
            entity.position.latitude,
            entity.position.altitude
        ),

        billboard: {
            image: EntityIconFactory.get(
                entity.definition.entityType
            ),

            width: selected ? 36 : 32,
            height: selected ? 36 : 32,

            scale: selected ? 1.08 : 1.0,

            color: selected
                ? Cesium.Color.fromCssColorString("#FFF8DC")
                : Cesium.Color.WHITE,

            disableDepthTestDistance: Number.POSITIVE_INFINITY,

            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,

            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER
        }
    });
}


      private drawTeamDot(entity: Entity): void {
    this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(
            entity.position.longitude,
            entity.position.latitude,
            entity.position.altitude
        ),

        billboard: {
            image:
                entity.team === "Blue"
                    ? "assets/blue.png"
                    : "assets/red.png",

            color:
                entity.team === "Blue"
                    ? Cesium.Color.fromCssColorString("#3B82F6")
                    : Cesium.Color.WHITE,

            width: 16,
            height: 16,

            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,

            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,

            disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
    });
}
}