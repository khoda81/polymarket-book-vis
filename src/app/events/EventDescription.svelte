<script lang="ts">
  import type { EventDescription } from "../../domain/markets/eventDetails";

  export let description: EventDescription;
</script>

<details class="cpv-event-description">
  <summary>
    <span class="cpv-event-description-preview">
      {description.preview}
    </span>
    <span class="cpv-event-description-label">Description</span>
  </summary>
  <div class="cpv-event-description-body">{description.body}</div>
</details>
