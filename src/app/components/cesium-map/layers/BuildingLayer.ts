import * as Cesium from "cesium";

export class BuildingLayer {

  static async load(viewer: Cesium.Viewer): Promise<void> {

    console.log("========== DEHRADUN 3D TILES TEST ==========");

    const tileset = await Cesium.Cesium3DTileset.fromUrl(
      "/assets/test_tiles/tileset.json"
    );

    // Exact origin printed by your C++ exporter
    const origin = Cesium.Cartesian3.fromDegrees(
      78.04386500,
      30.34014610,
      0
    );

    // Apply ONLY the translation (no rotation)
    tileset.modelMatrix =
      Cesium.Transforms.eastNorthUpToFixedFrame(origin);

    viewer.scene.primitives.add(tileset);

    await viewer.zoomTo(tileset);

    console.log("Tileset loaded");
    console.log(
      "Bounding sphere:",
      tileset.boundingSphere.radius
    );
    console.log("==============================");
  }

}