import * as Cesium from "cesium";
import { Entity } from "../../core/models/Entity";
import { EntityIconFactory } from "../../core/factories/EntityIconFactory";
import { EditorState } from "../../core/state/EditorState";
import { CesiumCoverageRenderer } from './CesiumCoverageRenderer';
import { TeamFilterService } from "../../core/services/TeamFilterService";
import { Team } from "../../core/types/Team";
import { TeamFilter } from '../../core/models/TeamFilter';
import {
    CesiumRadarTerrainCone
} from "./CesiumRadarTerrainCone";

export class CesiumEntityRenderer {

    private readonly renderedEntities = new Set<string>();
    constructor(
        private viewer: Cesium.Viewer,
        private teamFilterService: TeamFilterService,
        private editorState: EditorState
    ) { }

    render(entities: Entity[]): void {

        console.log(
            "CESIUM RENDER CALLED",
            entities.length
        );

        const filter = this.teamFilterService.cesiumFilter();

        this.viewer.entities.removeAll();
        this.renderedEntities.clear();
        for (const entity of entities) {



            if (
                (filter === TeamFilter.Blue && entity.team !== Team.Blue) ||
                (filter === TeamFilter.Red && entity.team !== Team.Red)
            ) {
                continue;
            }
            const selected =
                this.editorState.selectedEntity()?.id === entity.id;


            this.drawRadar(entity);

            this.drawTeamDot(entity);




            /*
             * TEST TERRAIN BLOCKING
             */

            if (
                entity.definition.entityType === "RadarSite"
            ) {

                this.drawTerrainRadarCone(
                    entity
                );

            }

        }

    }

    private drawCoverage(entity: Entity): void {

        const coverages = CesiumCoverageRenderer.render(entity);

        for (const coverage of coverages) {

            this.viewer.entities.add(coverage);

        }



    }

   private async drawTerrainRadarCone(
    entity: Entity
): Promise<void> {

    /*
     * ---------------------------------------------------------
     * RADAR TEST SETTINGS
     * ---------------------------------------------------------
     */

    const range = 100000; // 100 km

    this.viewer.scene.globe.depthTestAgainstTerrain = true;
    const horizontalAngle = 360;

    const verticalAngle = 0;

    const heading = 0;

    const horizontalRays = 360;

    const verticalRays = 1;


    /*
     * ---------------------------------------------------------
     * Radar position
     * ---------------------------------------------------------
     */

    const radarPosition =
        Cesium.Cartesian3.fromDegrees(
            entity.position.longitude,
            entity.position.latitude,
            entity.position.altitude
        );


    /*
     * ---------------------------------------------------------
     * Calculate FIRST obstruction for every ray.
     * ---------------------------------------------------------
     */

    const results =
       await CesiumRadarTerrainCone.calculate(
            this.viewer,
            {
                longitude:
                    entity.position.longitude,

                latitude:
                    entity.position.latitude,

                altitude:
                    entity.position.altitude,

                range,

                heading,

                horizontalAngle,

                verticalAngle,

                horizontalRays,

                verticalRays
            }
        );


    /*
     * ---------------------------------------------------------
     * Draw exactly ONE line per ray.
     *
     * IMPORTANT:
     *
     * The endpoint is the FIRST obstruction.
     *
     * There is NEVER another segment after it.
     * ---------------------------------------------------------
     */

    for (const result of results) {

        this.viewer.entities.add({

            polyline: {

                positions: [
                    radarPosition,
                    result.endPosition
                ],

                width: 2,

                material:
                    result.blocked
                        ? Cesium.Color.CYAN
                            .withAlpha(0.9)
                        : Cesium.Color.CYAN
                            .withAlpha(0.45)

            }

        });
    }


   
    


    this.viewer.scene.requestRender();
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

                verticalOrigin: Cesium.VerticalOrigin.BOTTOM

            },

            label: {

                text:
                    `Name: ${entity.definition.name}
Type: ${entity.definition.entityType}
Role: ${entity.definition.role}
Team: ${entity.team}`,

                show: false,

                font: "11px Arial",

                fillColor: Cesium.Color.BLACK,

                showBackground: true,

                backgroundColor:
                    Cesium.Color.fromCssColorString("#ffffff")
                        .withAlpha(0.95),

                outlineColor: Cesium.Color.GRAY,

                outlineWidth: 1,

                style: Cesium.LabelStyle.FILL_AND_OUTLINE,

                pixelOffset:
                    new Cesium.Cartesian2(0, -32),

                horizontalOrigin:
                    Cesium.HorizontalOrigin.CENTER,

                verticalOrigin:
                    Cesium.VerticalOrigin.BOTTOM,

                disableDepthTestDistance:
                    Number.POSITIVE_INFINITY

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
                        ? Cesium.Color.fromCssColorString("#3B82F6")   // lighter blue
                        : Cesium.Color.WHITE,                          // keep red unchanged

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