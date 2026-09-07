import * as Cesium from "cesium";

export class BuildingLayer {
  static async load(viewer: Cesium.Viewer): Promise<void> {

    const tileset = await Cesium.Cesium3DTileset.fromUrl(
      "/assets/tiles/tileset.json"
    );

    viewer.scene.primitives.add(tileset);

    await viewer.zoomTo(tileset);

    // ONLY move camera to tower/tank location
   viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(
    78.06979012539479,
    30.296704600692998,
    300
  ),
  orientation: {
    heading: 0,
    pitch: Cesium.Math.toRadians(-45),
    roll: 0
  }
});

    console.log("Tileset loaded");
    console.log("Bounding radius:", tileset.boundingSphere.radius);
  }
}