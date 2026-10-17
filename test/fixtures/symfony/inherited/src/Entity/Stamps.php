<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

trait Stamps
{
    use CreatedStamp;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $updatedAt = null;
}
