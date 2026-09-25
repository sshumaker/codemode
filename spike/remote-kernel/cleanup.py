"""List (and with --delete, delete) every sandbox carrying the spike labels."""
import asyncio, sys
from dt_common import client, list_spike, LABELS


async def main():
    d = client()
    try:
        boxes = await list_spike(d)
        for s in boxes:
            assert all(s.labels.get(k) == v for k, v in LABELS.items()), s.labels
            print(s.id, s.state, s.labels)
            if "--delete" in sys.argv:
                await d.delete(s)
                print("  deleted")
        print(f"spike sandboxes found: {len(boxes)}")
    finally:
        await d.close()

asyncio.run(main())
