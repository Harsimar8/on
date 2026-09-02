import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  inject,
  effect
} from '@angular/core';

import * as Cesium from 'cesium';
import { CesiumPlacement } from './CesiumPlacement';
import { CesiumEntityRenderer } from "./CesiumEntityRenderer";
import { CesiumHover } from "./CesiumHover";
import { TeamFilter } from '../../core/models/TeamFilter';
import { EntityRepository } from "../../core/services/EntityRepository";
import { EditorState } from '../../core/state/EditorState';
import { TeamFilterService } from '../../core/services/TeamFilterService';
import { MapSyncService } from '../../core/services/MapSync';
import { CesiumSelection } from "./CesiumSelection";
import { BuildingLayer } from './layers/BuildingLayer';
import { VegetationLayer } from './layers/VegetationLayer';
import { RoadLayer } from './layers/RoadLayer';


Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIxNzFhZjQzZC0xNGNmLTQyNDAtOTFlMC1jMmEyMDQwOTExNDAiLCJpZCI6NDQyMjYxLCJzdWIiOiJIYXJzaW1hcjA4IiwiaXNzIjoiaHR0cHM6Ly9hcGkuY2VzaXVtLmNvbSIsImF1ZCI6Im1pc3Npb24iLCJpYXQiOjE3ODQwMDU4MjB9.NzxkVB0Hlz8uYySEa5PaSg7bycWumdeeUXiaJgk57XY';
@Component({
  selector: 'app-cesium-map',
  standalone: true,
  imports: [],
  templateUrl: './cesium-map.html',
  styleUrl: './cesium-map.css'
})
export class CesiumMap implements AfterViewInit, OnDestroy {

  constructor() {

    effect(() => {

      const state = this.mapSync.state();

      if (!this.viewer) return;



      if (state.source === 'cesium') {
        return;
      }

      const current = this.viewer.camera.positionCartographic;


      const lat = Cesium.Math.toDegrees(current.latitude);
      const lon = Cesium.Math.toDegrees(current.longitude);

      if (

        Math.abs(lat - state.latitude) > 0.0001 ||

        Math.abs(lon - state.longitude) > 0.0001

      ) {
        this.syncing = true;

        this.viewer.camera.setView({

          destination: Cesium.Cartesian3.fromDegrees(
            state.longitude,
            state.latitude,
            this.mapSync.leafletZoomToHeight(
              state.zoom,
              state.latitude,
              this.viewer.scene.canvas.clientHeight
            )
          )

        });

        clearTimeout(this.syncTimeout);

        this.syncTimeout = setTimeout(() => {

          this.syncing = false;

        }, 100);
      }

    });


    effect(() => {

      const entities = this.entityRepository.all();

      // Make this effect rerun when selection changes
      this.editorState.selectedEntity();
      const filter = this.teamFilterService.cesiumFilter();

      if (this.renderer) {

        this.renderer.render(entities);


      }

    });

  }

  @ViewChild('cesiumContainer', { static: true })
  cesiumContainer!: ElementRef<HTMLDivElement>;

  private viewer!: Cesium.Viewer;
  private readonly mapSync = inject(MapSyncService);
  private renderer!: CesiumEntityRenderer;
  public readonly teamFilterService = inject(TeamFilterService);
  private placement!: CesiumPlacement;
  private hover!: CesiumHover;
  private selection!: CesiumSelection;
  protected readonly TeamFilter = TeamFilter;

  private readonly entityRepository = inject(EntityRepository);
  private readonly editorState = inject(EditorState);

  private animationFrame?: number;

  private syncing = false;
  private syncTimeout?: ReturnType<typeof setTimeout>;
  private cesiumSyncFrame: number | null = null;

  async ngAfterViewInit(): Promise<void> {

    this.viewer = new Cesium.Viewer(


      this.cesiumContainer.nativeElement,
      {

        terrain: Cesium.Terrain.fromWorldTerrain(),


        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: true,
        sceneModePicker: true,
        navigationHelpButton: true,
        fullscreenButton: true,
        infoBox: false,
        selectionIndicator: false,

        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,


        terrainShadows: Cesium.ShadowMode.RECEIVE_ONLY,
      }
    );

    console.log(
  "CESIUM TERRAIN PROVIDER:",
  this.viewer.terrainProvider
);

this.viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(
    78.04386500,   // longitude
    30.34014610,   // latitude
    800            // camera height in meters
  ),
  orientation: {
    heading: 0.0,
    pitch: Cesium.Math.toRadians(-45),
    roll: 0.0
  }
});
    console.log(
      this.viewer.scene.screenSpaceCameraController.enableZoom
    );
    this.viewer.scene.screenSpaceCameraController.enableZoom = true;
    this.viewer.scene.screenSpaceCameraController.enableRotate = true;
    this.viewer.scene.screenSpaceCameraController.enableTilt = true;
    this.viewer.scene.screenSpaceCameraController.enableTranslate = true;
    this.viewer.scene.screenSpaceCameraController.enableLook = true;



    this.viewer.scene.fog.enabled = false;

   this.viewer.scene.globe.enableLighting = false;

    this.viewer.scene.light = new Cesium.SunLight({
      intensity: 1.6
    });

 this.viewer.scene.globe.depthTestAgainstTerrain = true;
   

await BuildingLayer.load(this.viewer);


    this.renderer = new CesiumEntityRenderer(
      this.viewer,

      this.teamFilterService,
      this.editorState
    );


    this.renderer.render(this.entityRepository.all());


    this.placement = new CesiumPlacement(

      this.viewer,

      this.editorState,

      this.entityRepository

    );

    this.selection = new CesiumSelection(

      this.viewer,

      this.editorState,

      this.entityRepository

    );

    // this.hover = new CesiumHover(
    //     this.viewer
    // );



    //     const handler = new Cesium.ScreenSpaceEventHandler(
    //       this.viewer.scene.canvas
    //     );

    const handler = new Cesium.ScreenSpaceEventHandler(
      this.viewer.scene.canvas
    );

    handler.setInputAction(
      this.handleLeftClick.bind(this),
      Cesium.ScreenSpaceEventType.LEFT_CLICK
    );
    //     handler.setInputAction(

    //       this.handleLeftClick.bind(this),

    //       Cesium.ScreenSpaceEventType.LEFT_CLICK

    //     );
    //     handler.setInputAction(

    //     this.hover.handleMouseMove.bind(this.hover),

    //     Cesium.ScreenSpaceEventType.MOUSE_MOVE

    // );



    this.viewer.camera.moveStart.addEventListener(() => {

      this.startCesiumCameraLoop();

    });

    this.viewer.camera.moveEnd.addEventListener(() => {

      this.stopCesiumCameraLoop();

    });

    // this.viewer.camera.changed.addEventListener(() => {
    //   this.viewer.scene.requestRender();
    // });
    this.viewer.scene.requestRender();
  }

  private startCesiumCameraLoop(): void {

    if (this.cesiumSyncFrame !== null) {
      return;
    }

    const tick = () => {

      if (!this.viewer || this.syncing) {

        this.cesiumSyncFrame = null;
        return;

      }

      const camera = this.viewer.camera.positionCartographic;

      const latitude = Cesium.Math.toDegrees(camera.latitude);
      const longitude = Cesium.Math.toDegrees(camera.longitude);

      const zoom = this.mapSync.heightToLeafletZoom(
        camera.height,
        latitude,
        this.viewer.scene.canvas.clientHeight
      );

      

      this.mapSync.update({

        latitude,
        longitude,
        zoom,
        source: 'cesium'

      });

      this.cesiumSyncFrame = requestAnimationFrame(tick);

    };

    this.cesiumSyncFrame = requestAnimationFrame(tick);

  }


  private stopCesiumCameraLoop(): void {

    if (this.cesiumSyncFrame !== null) {

      cancelAnimationFrame(this.cesiumSyncFrame);

      this.cesiumSyncFrame = null;

    }

  }

  setAllForces() {

    this.teamFilterService.setCesiumFilter(
      TeamFilter.All
    );

  }


  setBlueForces() {

    this.teamFilterService.setCesiumFilter(
      TeamFilter.Blue
    );

  }


  setRedForces() {

    this.teamFilterService.setCesiumFilter(
      TeamFilter.Red
    );

  }
  private isPointInPolygon(
    point: Cesium.Cartographic,
    polygon: Cesium.Cartographic[]
): boolean {

    let inside = false;

    for (
        let i = 0, j = polygon.length - 1;
        i < polygon.length;
        j = i++
    ) {

        const xi = Cesium.Math.toDegrees(polygon[i].longitude);
        const yi = Cesium.Math.toDegrees(polygon[i].latitude);

        const xj = Cesium.Math.toDegrees(polygon[j].longitude);
        const yj = Cesium.Math.toDegrees(polygon[j].latitude);

        const x = Cesium.Math.toDegrees(point.longitude);
        const y = Cesium.Math.toDegrees(point.latitude);

        const intersect =
            ((yi > y) !== (yj > y)) &&
            (x <
                (xj - xi) *
                    (y - yi) /
                    (yj - yi) +
                    xi);

        if (intersect) {
            inside = !inside;
        }
    }

    return inside;
}

  private handleLeftClick(
    click: Cesium.ScreenSpaceEventHandler.PositionedEvent
  ): void {

    if (this.editorState.placementMode()) {

      this.placement.placeEntity(click);

    } else {

      this.selection.selectEntity(click);

    }

  }

  public resize(): void {

    this.viewer.resize();

  }

  ngOnDestroy(): void {

    this.viewer.destroy();

  }

}