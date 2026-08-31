// Your Teachable Machine Pose Model URL
const URL = "https://teachablemachine.withgoogle.com/models/qjqKkGZHb/";

let model;
let webcam;
let ctx;
let labelContainer;
let maxPredictions;
let isRunning = false;


// Initialize the AI Pose Detection
async function init() {

    // Prevent starting multiple cameras
    if (isRunning) {
        return;
    }

    try {

        document.getElementById("start-btn").innerText =
            "Loading Model...";


        // Model URLs
        const modelURL = URL + "model.json";
        const metadataURL = URL + "metadata.json";


        // Load Teachable Machine model
        model = await tmPose.load(
            modelURL,
            metadataURL
        );


        // Get number of classes
        maxPredictions =
            model.getTotalClasses();


        // Webcam size
        const size = 400;
        const flip = true;


        // Create webcam
        webcam = new tmPose.Webcam(
            size,
            size,
            flip
        );


        // Setup webcam
        await webcam.setup();


        // Start webcam
        await webcam.play();


        // Canvas
        const canvas =
            document.getElementById("canvas");

        canvas.width = size;
        canvas.height = size;


        // Canvas context
        ctx =
            canvas.getContext("2d");


        // Prediction container
        labelContainer =
            document.getElementById(
                "label-container"
            );


        // Clear previous predictions
        labelContainer.innerHTML = "";


        // Create prediction boxes
        for (
            let i = 0;
            i < maxPredictions;
            i++
        ) {

            const predictionBox =
                document.createElement("div");

            predictionBox.className =
                "prediction";


            labelContainer.appendChild(
                predictionBox
            );
        }


        isRunning = true;


        document.getElementById("start-btn").innerText =
            "Camera Running";


        // Start detection loop
        window.requestAnimationFrame(loop);

    }

    catch (error) {

        console.error(error);

        alert(
            "Camera access or model loading failed. Please allow camera permission."
        );


        document.getElementById("start-btn").innerText =
            "Start Camera";
    }
}


// Detection loop
async function loop() {

    if (!isRunning) {
        return;
    }


    // Update webcam frame
    webcam.update();


    // Predict pose
    await predict();


    // Continue loop
    window.requestAnimationFrame(loop);
}


// Predict the user's pose
async function predict() {

    // Detect body pose
    const {
        pose,
        posenetOutput
    } = await model.estimatePose(
        webcam.canvas
    );


    // Get prediction results
    const prediction =
        await model.predict(
            posenetOutput
        );


    // Display prediction percentages
    for (
        let i = 0;
        i < maxPredictions;
        i++
    ) {

        const percentage =
            (
                prediction[i].probability * 100
            ).toFixed(2);


        const classPrediction =
            prediction[i].className +
            " : " +
            percentage +
            "%";


        labelContainer
            .childNodes[i]
            .innerHTML =
            classPrediction;
    }


    // Draw webcam image
    ctx.drawImage(
        webcam.canvas,
        0,
        0
    );


    // Draw body keypoints
    tmPose.drawKeypoints(
        pose.keypoints,
        0.5,
        ctx
    );


    // Draw body skeleton
    tmPose.drawSkeleton(
        pose.keypoints,
        0.5,
        ctx
    );
}