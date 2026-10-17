<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

trait CreatedStamp
{
    #[ORM\Column]
    private ?\DateTimeImmutable $createdAt = null;
}
