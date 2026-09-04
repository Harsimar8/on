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

    constructor(
        private viewer: Cesium.Viewer,
        private terrainProvider: Cesium.TerrainProvider,
        private teamFilterService: TeamFilterService,
        private editorState: EditorState
    ) {}

    render(entities: Entity[]): void {
        const filter = this.teamFilterService.cesiumFilter();

        // 1. Remove all billboards and standard entities
        this.viewer.entities.removeAll();

        // 2. Clean up previously created 3D radar cylinders
        for (const [_, entityList] of this.radarEntities) {
            for (const ent of entityList) {
                this.viewer.entities.remove(ent);
            }
        }
        this.radarEntities.clear();

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
                this.drawTerrainRadarCone(entity);
            }
        }

        this.viewer.scene.requestRender();
    }

    private async drawTerrainRadarCone(entity: Entity): Promise<void> {
        try {
            const radar3DEntities = await Cesium3DRadarCoverage.create3DRadarZones(
                this.viewer,
                this.terrainProvider,
                {
                    longitude: entity.position.longitude,
                    latitude: entity.position.latitude,
                    antennaMastHeight: 25,
                    numAzimuths: 72,
                    zones: Cesium3DRadarCoverage.DEFAULT_3D_ZONES
                }
            );

            // Store cleanly in the map
            this.radarEntities.set(entity.id, radar3DEntities);

            // Request render so Cesium updates the viewport immediately
            this.viewer.scene.requestRender();
        } catch (err) {
            console.error("Failed to render 3D radar coverage:", err);
        }
    }

    private drawRadar(entity: Entity): void {
        const selected = this.editorState.selectedEntity()?.id === entity.id;

        const carto = Cesium.Cartographic.fromDegrees(entity.position.longitude, entity.position.latitude);
        const terrainH = this.viewer.scene.globe.getHeight(carto) || entity.position.altitude || 0;

        this.viewer.entities.add({
            id: entity.id,
            position: Cesium.Cartesian3.fromDegrees(
                entity.position.longitude,
                entity.position.latitude,
                terrainH + 15
            ),
            billboard: {
                image: EntityIconFactory.get(entity.definition.entityType),
                width: selected ? 36 : 32,
                height: selected ? 36 : 32,
                scale: selected ? 1.08 : 1.0,
                color: selected ? Cesium.Color.fromCssColorString("#FFF8DC") : Cesium.Color.WHITE,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM
            }
        });
    }

    private drawTeamDot(entity: Entity): void {
        const carto = Cesium.Cartographic.fromDegrees(entity.position.longitude, entity.position.latitude);
        const terrainH = this.viewer.scene.globe.getHeight(carto) || entity.position.altitude || 0;

        this.viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(
                entity.position.longitude,
                entity.position.latitude,
                terrainH + 15
            ),
            billboard: {
                image: entity.team === "Blue" ? "assets/blue.png" : "assets/red.png",
                color: entity.team === "Blue" ? Cesium.Color.fromCssColorString("#3B82F6") : Cesium.Color.WHITE,
                width: 16,
                height: 16,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                pixelOffset: new Cesium.Cartesian2(-27, 14),
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
    }
}