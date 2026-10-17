<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

trait HasCode
{
    #[ORM\Column(length: 20)]
    private ?string $code = null;
}
