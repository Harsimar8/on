import * as Cesium from "cesium";

export class JaipurBuildingLayer {

    static async load(viewer: Cesium.Viewer): Promise<void> {

        const tileset =
            await Cesium.Cesium3DTileset.fromIonAssetId(5095133);

        viewer.scene.primitives.add(tileset);

        console.log("Tileset:", tileset);
        console.log("BoundingSphere:", tileset.boundingSphere);

        const carto = Cesium.Cartographic.fromCartesian(
            tileset.boundingSphere.center
        );

        console.log("Longitude:",
            Cesium.Math.toDegrees(carto.longitude));

        console.log("Latitude:",
            Cesium.Math.toDegrees(carto.latitude));

        console.log("Height:",
            carto.height);

        viewer.camera.flyToBoundingSphere(
            tileset.boundingSphere,
            {
                duration: 0
            }
        );

        console.log("JAIPUR BUILDINGS LOADED");
    }

}
