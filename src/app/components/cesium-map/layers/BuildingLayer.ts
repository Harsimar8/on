import * as Cesium from "cesium";

export class BuildingLayer {

  static async load(viewer: Cesium.Viewer): Promise<void> {


    console.log("========== 3D TILES TEST ==========");


    const tileset =
      await Cesium.Cesium3DTileset.fromUrl(
        "/assets/test_tiles/tileset.json"
      );


      tileset.style = new Cesium.Cesium3DTileStyle({
      color: "color('#B22222')" // Firebrick (brick red)
    });


    
    
    const origin =
      Cesium.Cartesian3.fromDegrees(
        103.84797440,
        1.29709880,
        0
      );


    const transform =
      Cesium.Transforms.eastNorthUpToFixedFrame(
        origin
      );


    
    
    tileset.modelMatrix = transform;



    viewer.scene.primitives.add(
      tileset
    );


    await viewer.zoomTo(
      tileset
    );


    console.log("Tileset loaded");


    console.log(
      "Bounding:",
      tileset.boundingSphere.radius
    );


    console.log("==============================");


  }

}