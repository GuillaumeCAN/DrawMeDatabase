<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

trait TimestampableTrait
{
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $updatedAt = null;

    public function getUpdatedAt(): ?\DateTimeImmutable
    {
        return $this->updatedAt;
    }
}
