import * as Cesium from "cesium";

export class BuildingLayer {

  static async load(viewer: Cesium.Viewer): Promise<void> {

    console.log("========== GLB TEST ==========");


    // Your C++ origin
    const origin = Cesium.Cartesian3.fromDegrees(
      103.84797440,
      1.29709880,
      0
    );

    const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(origin);

const rotation = Cesium.Matrix3.fromRotationZ(
  Cesium.Math.toRadians(-90)
);

Cesium.Matrix4.multiplyByMatrix3(
  modelMatrix,
  rotation,
  modelMatrix
);


const model = await Cesium.Model.fromGltfAsync({

  url: "/assets/delhi_tiles/F.glb",

  modelMatrix: modelMatrix,

  scale: 1.0

});


    viewer.scene.primitives.add(model);


    await new Promise<void>((resolve) => {

      model.readyEvent.addEventListener(() => resolve());

    });


    console.log("GLB loaded");


    console.log(
      "Bounding sphere:",
      model.boundingSphere.radius
    );


    viewer.camera.flyToBoundingSphere(
      model.boundingSphere,
      {
        duration: 2,

        offset:
          new Cesium.HeadingPitchRange(
            0,
            Cesium.Math.toRadians(-45),
            model.boundingSphere.radius * 3
          )
      }
    );


    console.log("==============================");

  }

}