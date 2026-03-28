"""
Object Detection — real-time detection using YOLOv8.
Reads an image or webcam feed, outputs detected objects as JSON.

Usage:
  python scripts/detect-objects.py <image_path> [--confidence 0.5] [--output json|annotated]
  python scripts/detect-objects.py --webcam [--duration 10]

Requires:
  pip install ultralytics opencv-python
"""

import sys, os, json, argparse, time


def detect_image(image_path: str, confidence: float = 0.5, model_size: str = "yolov8n") -> dict:
    """Detect objects in a single image."""
    from ultralytics import YOLO
    import cv2

    if not os.path.exists(image_path):
        return {"error": f"File not found: {image_path}"}

    model = YOLO(f"{model_size}.pt")
    results = model(image_path, conf=confidence, verbose=False)

    detections = []
    for result in results:
        for box in result.boxes:
            cls_id = int(box.cls[0])
            cls_name = result.names[cls_id]
            conf = float(box.conf[0])
            x1, y1, x2, y2 = [float(v) for v in box.xyxy[0]]

            detections.append({
                "class": cls_name,
                "confidence": round(conf, 3),
                "bbox": {
                    "x": round(x1),
                    "y": round(y1),
                    "width": round(x2 - x1),
                    "height": round(y2 - y1),
                },
            })

    return {
        "image": image_path,
        "model": model_size,
        "detections": detections,
        "count": len(detections),
        "classes": list(set(d["class"] for d in detections)),
    }


def detect_webcam(duration: float = 10, confidence: float = 0.5, model_size: str = "yolov8n"):
    """Detect objects from webcam feed, outputting JSON per frame."""
    from ultralytics import YOLO
    import cv2

    model = YOLO(f"{model_size}.pt")
    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        print(json.dumps({"error": "Cannot open webcam"}), flush=True)
        return

    print(json.dumps({"status": "started", "duration": duration}), flush=True)

    start = time.time()
    frame_count = 0

    try:
        while time.time() - start < duration:
            ret, frame = cap.read()
            if not ret:
                break

            frame_count += 1
            # Process every 5th frame for performance
            if frame_count % 5 != 0:
                continue

            results = model(frame, conf=confidence, verbose=False)

            detections = []
            for result in results:
                for box in result.boxes:
                    cls_id = int(box.cls[0])
                    cls_name = result.names[cls_id]
                    conf = float(box.conf[0])
                    x1, y1, x2, y2 = [float(v) for v in box.xyxy[0]]

                    detections.append({
                        "class": cls_name,
                        "confidence": round(conf, 3),
                        "bbox": {
                            "x": round(x1),
                            "y": round(y1),
                            "width": round(x2 - x1),
                            "height": round(y2 - y1),
                        },
                    })

            if detections:
                print(json.dumps({
                    "frame": frame_count,
                    "timestamp": round(time.time() - start, 2),
                    "detections": detections,
                    "count": len(detections),
                }), flush=True)

    finally:
        cap.release()
        print(json.dumps({"status": "stopped", "frames_processed": frame_count}), flush=True)


def save_annotated(image_path: str, output_path: str, confidence: float = 0.5, model_size: str = "yolov8n"):
    """Save image with bounding boxes drawn."""
    from ultralytics import YOLO
    import cv2

    model = YOLO(f"{model_size}.pt")
    results = model(image_path, conf=confidence, verbose=False)

    annotated = results[0].plot()
    cv2.imwrite(output_path, annotated)

    return {"saved": output_path, "detections": len(results[0].boxes)}


def main():
    parser = argparse.ArgumentParser(description="YOLOv8 object detection")
    parser.add_argument("image", nargs="?", help="Path to image file")
    parser.add_argument("--webcam", action="store_true", help="Use webcam feed")
    parser.add_argument("--duration", type=float, default=10, help="Webcam capture duration (seconds)")
    parser.add_argument("--confidence", type=float, default=0.5, help="Min detection confidence")
    parser.add_argument("--model", default="yolov8n", help="Model size: yolov8n, yolov8s, yolov8m, yolov8l, yolov8x")
    parser.add_argument("--output", choices=["json", "annotated"], default="json")
    parser.add_argument("--save-to", help="Path to save annotated image")
    args = parser.parse_args()

    if args.webcam:
        detect_webcam(args.duration, args.confidence, args.model)
    elif args.image:
        if args.output == "annotated" and args.save_to:
            result = save_annotated(args.image, args.save_to, args.confidence, args.model)
            print(json.dumps(result))
        else:
            result = detect_image(args.image, args.confidence, args.model)
            print(json.dumps(result, indent=2))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
